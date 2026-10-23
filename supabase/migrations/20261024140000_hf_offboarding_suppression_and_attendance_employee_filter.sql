-- =============================================================================
-- Hotfix: Offboarding Report Snapshot Suppression & Attendance Employee Filter
--
-- Part A — Workforce Offboarding Report ("Báo cáo NLĐ nghỉ việc"):
--   1. Append-only snapshot suppression table (`public.direct_entry_offboarding_suppressions`)
--      with Forced RLS, zero client/service table grants, immutability trigger,
--      idempotent replay (`(hidden_by_user_id, idempotency_key)`), and zero raw/derived CCCD.
--   2. Snapshot semantics: suppression applies strictly to the worker's current
--      `(snapshot_entry_id, snapshot_status_event_id, snapshot_signature)` state.
--      Any new SUBMITTED recruitment episode or new/superseded employment status event
--      changes the snapshot and automatically invalidates prior suppressions.
--   3. Authority: `admin` and `bod` (`all` scope) receive `can_hide = true` and snapshot
--      references on list items, and may call `public.direct_entry_offboarding_hide_snapshot`.
--      `team_leader` receives `can_hide = false`, no snapshot references, and is rejected
--      with `42501` if calling the hide RPC. Suppressed rows disappear from both the
--      paginated list and the Excel export source without mutating `direct_entries` or
--      employment status events.
--
-- Part B — Attendance Admin Report Employee Filter Contract:
--   1. Adds 8-argument `public.attendance_admin_report(..., p_employee_id uuid)` returning:
--        - `employee_options`: deterministic `{ app_user_id, display_name, personnel_code }`
--          list for employees with check-ins in `[from_date, to_date]`, independent of
--          `p_employee_id` and `p_search`.
--        - `filters.employee_id`: echoed `uuid | null` filter.
--        - Exact filtering by `attendance_checkins.app_user_id = p_employee_id` across
--          `overview`, `pagination`, and `items`, failing closed (`22023`) if both
--          non-empty `p_search` and non-null `p_employee_id` are supplied together.
--   2. Preserves the 7-argument `public.attendance_admin_report` signature as a delegate
--      passing `null::uuid` for backward compatibility and ACL allowlist stability.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Append-only offboarding snapshot suppression table & immutability guard.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry__internal_offboarding_suppression_immutable()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  raise exception 'direct_entry_offboarding_suppressions is append-only'
    using errcode = '55000';
end;
$function$;

comment on function public.direct_entry__internal_offboarding_suppression_immutable() is
  'Internal immutability trigger function blocking UPDATE/DELETE on public.direct_entry_offboarding_suppressions.';

create table public.direct_entry_offboarding_suppressions (
  suppression_id uuid primary key default gen_random_uuid(),
  snapshot_entry_id uuid not null
    references public.direct_entries(entry_id) on delete restrict,
  snapshot_status_event_id uuid not null
    references public.direct_entry_employment_status_events(event_id) on delete restrict,
  snapshot_signature text not null,
  reason text not null,
  hidden_by_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  hidden_at timestamp with time zone not null default pg_catalog.clock_timestamp(),
  idempotency_key text not null,

  constraint direct_entry_offboarding_suppressions_actor_idempotency_key
    unique (hidden_by_user_id, idempotency_key),
  constraint direct_entry_offboarding_suppressions_signature_chk
    check (snapshot_signature ~ '^[0-9a-f]{32}$'),
  constraint direct_entry_offboarding_suppressions_reason_chk
    check (
      reason = pg_catalog.btrim(reason)
      and pg_catalog.length(reason) between 1 and 500
      and reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ),
  constraint direct_entry_offboarding_suppressions_hidden_at_finite_chk
    check (
      hidden_at not in (
        'infinity'::timestamp with time zone,
        '-infinity'::timestamp with time zone
      )
    ),
  constraint direct_entry_offboarding_suppressions_idempotency_key_chk
    check (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$')
);

create index direct_entry_offboarding_suppressions_snapshot_idx
  on public.direct_entry_offboarding_suppressions (
    snapshot_entry_id,
    snapshot_status_event_id,
    snapshot_signature
  );

create trigger direct_entry_offboarding_suppressions_immutable_guard
  before update or delete on public.direct_entry_offboarding_suppressions
  for each row
  execute function public.direct_entry__internal_offboarding_suppression_immutable();

alter table public.direct_entry_offboarding_suppressions enable row level security;
alter table public.direct_entry_offboarding_suppressions force row level security;

comment on table public.direct_entry_offboarding_suppressions is
  'Append-only snapshot suppressions for the offboarding report. Stores only entry/event UUID references and an entry/event-UUID digest; never stores raw or derived CCCD.';

-- -----------------------------------------------------------------------------
-- 2. Offboarding authority, internal snapshot-filtered rows, list, export & hide.
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
      'scope', 'all',
      'team_id', null,
      'can_phone', true,
      'can_export', true,
      'can_hide', true,
      'authority', 'admin'
    );
  exception when insufficient_privilege then
    null;
  end;

  if public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit')
     and public.direct_entry_has_scope(p_app_user_id, 'all') then
    return jsonb_build_object(
      'scope', 'all',
      'team_id', null,
      'can_phone', true,
      'can_export', true,
      'can_hide', true,
      'authority', 'bod'
    );
  end if;

  begin
    v_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
    return jsonb_build_object(
      'scope', 'team',
      'team_id', v_team_id,
      'can_phone', false,
      'can_export', false,
      'can_hide', false,
      'authority', 'team_leader'
    );
  exception when insufficient_privilege then
    null;
  end;

  raise exception 'offboarding report denied' using errcode = '42501';
end;
$function$;

comment on function public.direct_entry_offboarding_authority(uuid, uuid) is
  'Internal authority for the offboarding report. Returns {scope, team_id, can_phone, can_export, can_hide, authority} for Full Admin, BoD/Accounting, or current Team Leader; raises 42501 otherwise. Revoked from every role.';

create or replace function public.direct_entry__internal_offboarding_rows(
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
  phone text,
  snapshot_entry_id uuid,
  snapshot_status_event_id uuid,
  snapshot_signature text
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
           e.created_at as entry_created_at,
           s.submitted_at,
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
           ep.cccd,
           ep.entry_id,
           ep.employee_code,
           ep.project_id,
           ep.recruiter_id,
           ep.worker_details,
           ep.last_valid_off_date as last_off_date
      from ep
      join eligible el
        on el.cccd = ep.cccd
       and el.last_off_date = ep.last_valid_off_date
     order by ep.cccd, ep.first_work_date desc, ep.entry_id desc
  ),
  person_snapshot as (
    select el.cccd,
           (
             select ep_latest.entry_id
               from ep ep_latest
              where ep_latest.cccd = el.cccd
              order by ep_latest.first_work_date desc,
                       ep_latest.submitted_at desc,
                       ep_latest.entry_created_at desc,
                       ep_latest.entry_id desc
              limit 1
           ) as snapshot_entry_id,
           (
             select ev.event_id
               from ep ep_ev
               join public.direct_entry_employment_status_events ev
                 on ev.entry_id = ep_ev.entry_id
              where ep_ev.cccd = el.cccd
                and not exists (
                  select 1
                    from public.direct_entry_employment_status_events r
                   where r.supersedes_event_id = ev.event_id
                )
              order by (ev.effective_date <= public.direct_entry_authorization_date()) desc,
                       ev.effective_date desc,
                       ev.version desc,
                       ev.applied_at desc,
                       ev.event_id desc
              limit 1
           ) as snapshot_status_event_id,
           pg_catalog.md5(
             'entries:' || coalesce(
               (
                 select pg_catalog.string_agg(ep_sig.entry_id::text, ',' order by ep_sig.entry_id)
                   from ep ep_sig
                  where ep_sig.cccd = el.cccd
               ),
               ''
             ) || '|events:' || coalesce(
               (
                 select pg_catalog.string_agg(ev_sig.event_id::text, ',' order by ev_sig.event_id)
                   from ep ep_ev_sig
                   join public.direct_entry_employment_status_events ev_sig
                     on ev_sig.entry_id = ep_ev_sig.entry_id
                  where ep_ev_sig.cccd = el.cccd
                    and not exists (
                      select 1
                        from public.direct_entry_employment_status_events r_sig
                       where r_sig.supersedes_event_id = ev_sig.event_id
                    )
               ),
               ''
             )
           ) as snapshot_signature
      from eligible el
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
              else null end as phone,
         ps.snapshot_entry_id,
         ps.snapshot_status_event_id,
         ps.snapshot_signature
    from last_ep le
    join person_snapshot ps
      on ps.cccd = le.cccd
    join public.direct_entry_projects p
      on p.project_id = le.project_id
    join public.recruiters r
      on r.recruiter_id = le.recruiter_id
   where not exists (
           select 1
             from public.direct_entry_offboarding_suppressions sup
            where sup.snapshot_entry_id = ps.snapshot_entry_id
              and sup.snapshot_status_event_id = ps.snapshot_status_event_id
              and sup.snapshot_signature = ps.snapshot_signature
         )
     and (
       p_scope = 'all'
       or exists (
         select 1
           from public.recruiter_team_memberships m
          where m.recruiter_id = le.recruiter_id
            and m.team_id = p_team_id
            and m.is_current
       )
     );
end;
$function$;

comment on function public.direct_entry__internal_offboarding_rows(uuid, uuid, text, uuid, boolean) is
  'Internal offboarding rows with current snapshot references and active suppression filtering; never emits raw or derived CCCD. Revoked from every runtime role.';

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
  -- Workforce convention preserved via direct_entry__internal_offboarding_rows:
  -- supersedes_event_id, effective_date <= public.direct_entry_authorization_date(),
  -- order by ev.effective_date desc, ev.version desc, days_since_off, recruiter_team_memberships.
  return query
  select r.employee_code,
         r.display_name,
         r.project_id,
         r.project_display,
         r.recruiter_id,
         r.recruiter_display,
         r.off_effective_date,
         r.days_since_off,
         r.phone
    from public.direct_entry__internal_offboarding_rows(
      p_auth_subject, p_app_user_id, p_scope, p_team_id, p_can_phone
    ) r;
end;
$function$;

comment on function public.direct_entry_offboarding_rows(uuid, uuid, text, uuid, boolean) is
  'Internal 9-column offboarding rows delegate (suppressed snapshots excluded, CCCD never returned). Revoked from every runtime role.';

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
  v_can_hide boolean;
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
  v_can_hide := (v_auth->>'can_hide')::boolean;

  select count(*)::int into v_total
    from public.direct_entry__internal_offboarding_rows(
      p_auth_subject, p_app_user_id, v_scope, v_team_id, v_can_phone
    );

  select coalesce(
           jsonb_agg(
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
             || case when v_can_phone
                     then jsonb_build_object('phone', r.phone)
                     else '{}'::jsonb end
             || case when v_can_hide
                     then jsonb_build_object(
                       'snapshot_entry_id', r.snapshot_entry_id,
                       'snapshot_status_event_id', r.snapshot_status_event_id
                     )
                     else '{}'::jsonb end
             order by r.off_effective_date asc, r.employee_code asc
           ),
           '[]'::jsonb
         )
    into v_items
    from (
      select r.employee_code,
             r.display_name,
             r.project_id,
             r.project_display,
             r.recruiter_id,
             r.recruiter_display,
             r.off_effective_date,
             r.days_since_off,
             r.phone,
             r.snapshot_entry_id,
             r.snapshot_status_event_id
        from public.direct_entry__internal_offboarding_rows(
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
    'can_hide', v_can_hide,
    'authorization_date', public.direct_entry_authorization_date(),
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'has_more', v_has_more,
    'items', v_items
  );
end;
$function$;

comment on function public.direct_entry_offboarding_report(uuid, uuid, integer, integer) is
  'Offboarding report list. Full Admin and BoD/Accounting see all non-suppressed workers, phone numbers, and snapshot references (can_hide = true); a current Team Leader sees team-scoped non-suppressed workers without phone or hide references (can_hide = false). CCCD never returned. service_role only.';

create or replace function public.direct_entry_offboarding_hide_snapshot(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_snapshot_entry_id uuid,
  p_snapshot_status_event_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_idempotency_key text := nullif(pg_catalog.btrim(coalesce(p_idempotency_key, '')), '');
  v_existing public.direct_entry_offboarding_suppressions%rowtype;
  v_cccd text;
  v_signature text;
  v_inserted public.direct_entry_offboarding_suppressions%rowtype;
begin
  v_auth := public.direct_entry_offboarding_authority(p_auth_subject, p_app_user_id);
  if (v_auth->>'can_hide')::boolean is not true then
    raise exception 'WORKFORCE_OFFBOARDING_HIDE_DENIED' using errcode = '42501';
  end if;

  if p_snapshot_entry_id is null
     or p_snapshot_status_event_id is null
     or v_reason is null
     or pg_catalog.length(v_reason) > 500
     or v_reason ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or v_idempotency_key is null
     or v_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$' then
    raise exception 'WORKFORCE_OFFBOARDING_HIDE_INVALID' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'offboarding_hide:' || p_app_user_id::text || ':' || v_idempotency_key,
      0
    )
  );

  select s.*
    into v_existing
    from public.direct_entry_offboarding_suppressions s
   where s.hidden_by_user_id = p_app_user_id
     and s.idempotency_key = v_idempotency_key;

  if found then
    if v_existing.snapshot_entry_id <> p_snapshot_entry_id
       or v_existing.snapshot_status_event_id <> p_snapshot_status_event_id
       or v_existing.reason <> v_reason then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;

    return jsonb_build_object(
      'suppression_id', v_existing.suppression_id,
      'snapshot_entry_id', v_existing.snapshot_entry_id,
      'snapshot_status_event_id', v_existing.snapshot_status_event_id,
      'hidden_at', pg_catalog.to_char(v_existing.hidden_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'replayed', true
    );
  end if;

  select public.direct_entry_canonical_national_id(
           e.worker_details->'national_id'->>'value'
         )
    into v_cccd
    from public.direct_entries e
    join public.direct_entry_submissions s
      on s.submission_id = e.submission_id
     and s.state = 'SUBMITTED'
   where e.entry_id = p_snapshot_entry_id
     and e.deleted_at is null
     and e.voided_at is null
     and e.worker_details->'national_id'->>'state' = 'provided';

  if v_cccd is null or not public.direct_entry_is_canonical_national_id(v_cccd) then
    raise exception 'WORKFORCE_OFFBOARDING_SNAPSHOT_STALE' using errcode = '40001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('offboarding_person:' || v_cccd, 0)
  );

  select r.snapshot_signature
    into v_signature
    from public.direct_entry__internal_offboarding_rows(
      p_auth_subject, p_app_user_id, 'all', null, false
    ) r
   where r.snapshot_entry_id = p_snapshot_entry_id
     and r.snapshot_status_event_id = p_snapshot_status_event_id
   limit 1;

  if v_signature is null then
    raise exception 'WORKFORCE_OFFBOARDING_SNAPSHOT_STALE' using errcode = '40001';
  end if;

  insert into public.direct_entry_offboarding_suppressions (
    snapshot_entry_id,
    snapshot_status_event_id,
    snapshot_signature,
    reason,
    hidden_by_user_id,
    idempotency_key
  )
  values (
    p_snapshot_entry_id,
    p_snapshot_status_event_id,
    v_signature,
    v_reason,
    p_app_user_id,
    v_idempotency_key
  )
  returning * into v_inserted;

  return jsonb_build_object(
    'suppression_id', v_inserted.suppression_id,
    'snapshot_entry_id', v_inserted.snapshot_entry_id,
    'snapshot_status_event_id', v_inserted.snapshot_status_event_id,
    'hidden_at', pg_catalog.to_char(v_inserted.hidden_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'replayed', false
  );
end;
$function$;

comment on function public.direct_entry_offboarding_hide_snapshot(uuid, uuid, uuid, uuid, text, text) is
  'Service-role-only RPC allowing Full Admin or BoD (all scope) to suppress a worker''s current offboarding snapshot with a trimmed reason and idempotent replay. Never stores or emits CCCD.';

-- -----------------------------------------------------------------------------
-- 3. Attendance Admin Report Employee Filter Contract (8-arg RPC + 7-arg delegate).
-- -----------------------------------------------------------------------------
create or replace function public.attendance_admin_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_from_date date,
  p_to_date date,
  p_page integer,
  p_page_size integer,
  p_search text,
  p_employee_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_can_configure_hq boolean;
  v_today date := (pg_catalog.clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_to_date date := coalesce(p_to_date, v_today);
  v_from_date date := coalesce(p_from_date, coalesce(p_to_date, v_today) - 6);
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_search text := nullif(pg_catalog.btrim(coalesce(p_search, '')), '');
  v_search_pattern text := null;
  v_employee_options jsonb := '[]'::jsonb;
  v_current_hq jsonb;
  v_overview jsonb;
  v_total_rows integer := 0;
  v_total_pages integer := 1;
  v_items jsonb := '[]'::jsonb;
begin
  v_can_configure_hq := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  if v_from_date in ('infinity'::date, '-infinity'::date)
     or v_to_date in ('infinity'::date, '-infinity'::date)
     or v_from_date > v_to_date
     or (v_to_date - v_from_date) > 366 then
    raise exception 'ATTENDANCE_REPORT_RANGE_INVALID' using errcode = '22023';
  end if;

  if v_page < 1 or v_page > 1000 or v_page_size < 1 or v_page_size > 100 then
    raise exception 'ATTENDANCE_REPORT_PAGINATION_INVALID' using errcode = '22023';
  end if;

  if v_search is not null then
    if pg_catalog.length(v_search) > 120 or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'ATTENDANCE_REPORT_SEARCH_INVALID' using errcode = '22023';
    end if;
    if p_employee_id is not null then
      raise exception 'ATTENDANCE_REPORT_FILTER_CONFLICT' using errcode = '22023';
    end if;
    v_search_pattern :=
      '%' || pg_catalog.replace(
        pg_catalog.replace(
          pg_catalog.replace(v_search, '\', '\\'),
          '%',
          '\%'
        ),
        '_',
        '\_'
      ) || '%';
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'app_user_id', eo.app_user_id,
               'display_name', eo.display_name,
               'personnel_code', eo.personnel_code
             )
             order by pg_catalog.lower(eo.display_name) asc,
                      eo.display_name asc,
                      coalesce(eo.personnel_code, '') asc,
                      eo.app_user_id asc
           ),
           '[]'::jsonb
         )
    into v_employee_options
    from (
      select distinct
        c.app_user_id,
        u.display_name,
        rec.personnel_code
      from public.attendance_checkins c
      join public.direct_entry_app_users u
        on u.app_user_id = c.app_user_id
      left join lateral (
        select case when count(*) = 1 then max(r.personnel_code) else null end as personnel_code
          from public.direct_entry_app_user_recruiter_links l
          join public.recruiters r
            on r.recruiter_id = l.recruiter_id
           and r.active
         where l.app_user_id = u.app_user_id
           and l.verified
           and l.is_current
      ) rec on true
      where c.business_date between v_from_date and v_to_date
    ) eo;

  select jsonb_build_object(
           'version', h.version,
           'latitude', h.latitude,
           'longitude', h.longitude,
           'effective_from', pg_catalog.to_char(h.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'effective_from_local', pg_catalog.to_char(h.effective_from at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS'),
           'configured_by_display_name', u.display_name
         )
    into v_current_hq
    from public.attendance_hq_location_revisions h
    join public.direct_entry_app_users u
      on u.app_user_id = h.configured_by_user_id
   order by h.effective_from desc, h.version desc
   limit 1;

  with filtered_base as (
    select
      c.checkin_id,
      c.app_user_id,
      u.display_name as employee_display_name,
      rec.personnel_code,
      c.business_date,
      c.sequence_in_day,
      c.captured_at,
      c.received_at,
      c.time_source,
      c.time_verified,
      c.sync_delay_seconds,
      c.latitude,
      c.longitude,
      c.accuracy_meters,
      c.address_hint,
      c.note,
      (
        c.latitude is not null
        and c.longitude is not null
        and c.accuracy_meters is not null
        and c.latitude not in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
        and c.longitude not in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
        and c.accuracy_meters not in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
        and c.latitude >= -90.0 and c.latitude <= 90.0
        and c.longitude >= -180.0 and c.longitude <= 180.0
        and c.accuracy_meters >= 0.0 and c.accuracy_meters <= 100000.0
      ) as gps_valid,
      hq.version as hq_version,
      hq.latitude as hq_latitude,
      hq.longitude as hq_longitude
    from public.attendance_checkins c
    join public.direct_entry_app_users u
      on u.app_user_id = c.app_user_id
    left join lateral (
      select case when count(*) = 1 then max(r.personnel_code) else null end as personnel_code
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r
          on r.recruiter_id = l.recruiter_id
         and r.active
       where l.app_user_id = u.app_user_id
         and l.verified
         and l.is_current
    ) rec on true
    left join lateral (
      select h.version, h.latitude, h.longitude
        from public.attendance_hq_location_revisions h
       where h.effective_from <= (
         case when c.time_verified then c.captured_at else c.received_at end
       )
       order by h.effective_from desc, h.version desc
       limit 1
    ) hq on true
    where c.business_date between v_from_date and v_to_date
      and (p_employee_id is null or c.app_user_id = p_employee_id)
      and (
        v_search_pattern is null
        or u.display_name ilike v_search_pattern escape '\'
        or coalesce(rec.personnel_code, '') ilike v_search_pattern escape '\'
      )
  ),
  computed as (
    select
      b.checkin_id,
      b.app_user_id,
      b.employee_display_name,
      b.personnel_code,
      b.business_date,
      b.sequence_in_day,
      b.captured_at,
      b.received_at,
      b.time_source,
      b.time_verified,
      b.sync_delay_seconds,
      case when b.gps_valid then b.latitude else null end as latitude,
      case when b.gps_valid then b.longitude else null end as longitude,
      case when b.gps_valid then b.accuracy_meters else null end as accuracy_meters,
      b.address_hint,
      b.note,
      case
        when not b.gps_valid then 'INVALID_GPS'
        when b.hq_version is null then 'HQ_NOT_CONFIGURED'
        else 'COMPUTED'
      end as distance_status,
      case
        when b.gps_valid and b.hq_version is not null then b.hq_version
        else null
      end as hq_version_used,
      case
        when not b.gps_valid or b.hq_version is null then null
        else pg_catalog.round(
          (
            2.0 * 6371000.0 * pg_catalog.asin(
              least(
                1.0::double precision,
                pg_catalog.sqrt(
                  greatest(
                    0.0::double precision,
                    pg_catalog.power(pg_catalog.sin(pg_catalog.radians(b.latitude - b.hq_latitude) / 2.0), 2.0)
                    + pg_catalog.cos(pg_catalog.radians(b.hq_latitude))
                      * pg_catalog.cos(pg_catalog.radians(b.latitude))
                      * pg_catalog.power(pg_catalog.sin(pg_catalog.radians(b.longitude - b.hq_longitude) / 2.0), 2.0)
                  )
                )
              )
            )
          )::numeric,
          1
        )::double precision
      end as distance_meters
    from filtered_base b
  ),
  agg as (
    select
      count(*)::integer as total_checkins,
      count(distinct c.app_user_id)::integer as unique_employees,
      count(*) filter (where c.time_verified)::integer as verified_time_count,
      count(*) filter (where not c.time_verified)::integer as unverified_time_count,
      count(*) filter (where c.distance_status = 'COMPUTED')::integer as distance_computed_count,
      count(*) filter (where c.distance_status <> 'COMPUTED')::integer as distance_unavailable_count,
      case
        when count(*) filter (where c.distance_status = 'COMPUTED') = 0 then null
        else pg_catalog.round(
          (avg(c.distance_meters) filter (where c.distance_status = 'COMPUTED'))::numeric,
          1
        )::double precision
      end as avg_distance_meters,
      case
        when count(*) filter (where c.distance_status = 'COMPUTED') = 0 then null
        else pg_catalog.round(
          (max(c.distance_meters) filter (where c.distance_status = 'COMPUTED'))::numeric,
          1
        )::double precision
      end as max_distance_meters
    from computed c
  ),
  paged as (
    select
      c.checkin_id,
      c.captured_at as raw_captured_at,
      c.employee_display_name,
      c.personnel_code,
      c.business_date::text as business_date,
      c.sequence_in_day,
      pg_catalog.to_char(c.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as captured_at,
      pg_catalog.to_char(c.captured_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') as captured_at_local,
      pg_catalog.to_char(c.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as received_at,
      c.time_source,
      c.time_verified,
      c.sync_delay_seconds,
      c.latitude,
      c.longitude,
      c.accuracy_meters,
      c.address_hint,
      c.note,
      c.distance_meters,
      c.distance_status,
      c.hq_version_used
    from computed c
    order by c.captured_at desc, c.checkin_id desc
    offset ((v_page - 1) * v_page_size)
    limit v_page_size
  )
  select
    jsonb_build_object(
      'total_checkins', a.total_checkins,
      'unique_employees', a.unique_employees,
      'verified_time_count', a.verified_time_count,
      'unverified_time_count', a.unverified_time_count,
      'distance_computed_count', a.distance_computed_count,
      'distance_unavailable_count', a.distance_unavailable_count,
      'avg_distance_meters', a.avg_distance_meters,
      'max_distance_meters', a.max_distance_meters
    ),
    a.total_checkins,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'checkin_id', p.checkin_id,
            'employee_display_name', p.employee_display_name,
            'personnel_code', p.personnel_code,
            'business_date', p.business_date,
            'sequence_in_day', p.sequence_in_day,
            'captured_at', p.captured_at,
            'captured_at_local', p.captured_at_local,
            'received_at', p.received_at,
            'time_source', p.time_source,
            'time_verified', p.time_verified,
            'sync_delay_seconds', p.sync_delay_seconds,
            'latitude', p.latitude,
            'longitude', p.longitude,
            'accuracy_meters', p.accuracy_meters,
            'address_hint', p.address_hint,
            'note', p.note,
            'distance_meters', p.distance_meters,
            'distance_status', p.distance_status,
            'hq_version_used', p.hq_version_used
          )
          order by p.raw_captured_at desc, p.checkin_id desc
        )
        from paged p
      ),
      '[]'::jsonb
    )
    into v_overview, v_total_rows, v_items
    from agg a;

  v_total_pages := greatest(
    1,
    pg_catalog.ceil(v_total_rows::numeric / v_page_size::numeric)::integer
  );

  return jsonb_build_object(
    'viewer', jsonb_build_object(
      'can_configure_hq', v_can_configure_hq
    ),
    'filters', jsonb_build_object(
      'from_date', v_from_date::text,
      'to_date', v_to_date::text,
      'search', v_search,
      'employee_id', p_employee_id,
      'timezone', 'Asia/Ho_Chi_Minh'
    ),
    'employee_options', v_employee_options,
    'current_hq', v_current_hq,
    'overview', v_overview,
    'pagination', jsonb_build_object(
      'page', v_page,
      'page_size', v_page_size,
      'total_rows', v_total_rows,
      'total_pages', v_total_pages,
      'has_more', (v_page * v_page_size) < v_total_rows
    ),
    'items', v_items
  );
end;
$function$;

comment on function public.attendance_admin_report(
  uuid, uuid, date, date, integer, integer, text, uuid
) is
  'Service-role-only read-only Attendance Admin Report RPC for Admin and BoD. Emits deterministic date-scoped employee_options and supports exact p_employee_id filtering alongside legacy p_search (mutually exclusive).';

create or replace function public.attendance_admin_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_from_date date default null,
  p_to_date date default null,
  p_page integer default 1,
  p_page_size integer default 25,
  p_search text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  return public.attendance_admin_report(
    p_auth_subject,
    p_app_user_id,
    p_from_date,
    p_to_date,
    p_page,
    p_page_size,
    p_search,
    null::uuid
  );
end;
$function$;

comment on function public.attendance_admin_report(
  uuid, uuid, date, date, integer, integer, text
) is
  'Backward-compatible 7-argument delegate to public.attendance_admin_report(uuid, uuid, date, date, integer, integer, text, uuid) with p_employee_id = null.';

-- -----------------------------------------------------------------------------
-- 4. Owner alignment, strict ACLs & cross-owner helper execution grants.
-- -----------------------------------------------------------------------------
do $align_hf_offboarding_and_attendance_owners$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_sup_table_owner_oid oid;
  v_proc_owner_oid oid;
  v_sig text;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  select c.relowner
    into v_sup_table_owner_oid
    from pg_catalog.pg_class c
   where c.oid = 'public.direct_entry_offboarding_suppressions'::pg_catalog.regclass;

  if v_sup_table_owner_oid is distinct from v_base_owner_oid
     and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
    execute pg_catalog.format(
      'alter table public.direct_entry_offboarding_suppressions owner to %I',
      v_base_owner
    );
  end if;

  foreach v_sig in array array[
    'public.direct_entry__internal_offboarding_suppression_immutable()',
    'public.direct_entry_offboarding_authority(uuid,uuid)',
    'public.direct_entry__internal_offboarding_rows(uuid,uuid,text,uuid,boolean)',
    'public.direct_entry_offboarding_rows(uuid,uuid,text,uuid,boolean)',
    'public.direct_entry_offboarding_report(uuid,uuid,integer,integer)',
    'public.direct_entry_offboarding_hide_snapshot(uuid,uuid,uuid,uuid,text,text)',
    'public.attendance_admin_report(uuid,uuid,date,date,integer,integer,text,uuid)',
    'public.attendance_admin_report(uuid,uuid,date,date,integer,integer,text)'
  ]
  loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(v_sig);

    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
  end loop;
end;
$align_hf_offboarding_and_attendance_owners$;

revoke all on table public.direct_entry_offboarding_suppressions
  from public, anon, authenticated, service_role;

revoke all on function public.direct_entry__internal_offboarding_suppression_immutable()
  from public, anon, authenticated, service_role;

revoke all on function public.direct_entry_offboarding_authority(uuid, uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.direct_entry__internal_offboarding_rows(uuid, uuid, text, uuid, boolean)
  from public, anon, authenticated, service_role;

revoke all on function public.direct_entry_offboarding_rows(uuid, uuid, text, uuid, boolean)
  from public, anon, authenticated, service_role;

revoke all on function public.direct_entry_offboarding_report(uuid, uuid, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_offboarding_report(uuid, uuid, integer, integer)
  to service_role;

revoke all on function public.direct_entry_offboarding_report_export(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_offboarding_report_export(uuid, uuid)
  to service_role;

revoke all on function public.direct_entry_offboarding_hide_snapshot(uuid, uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_offboarding_hide_snapshot(uuid, uuid, uuid, uuid, text, text)
  to service_role;

revoke all on function public.attendance_admin_report(
  uuid, uuid, date, date, integer, integer, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.attendance_admin_report(
  uuid, uuid, date, date, integer, integer, text, uuid
) to service_role;

revoke all on function public.attendance_admin_report(
  uuid, uuid, date, date, integer, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.attendance_admin_report(
  uuid, uuid, date, date, integer, integer, text
) to service_role;

do $grant_hf_internal_owner_exec$
declare
  v_base_owner name;
  v_owner name;
begin
  select r.rolname
    into v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  execute pg_catalog.format(
    'grant select, insert on table public.direct_entry_offboarding_suppressions to %I',
    v_base_owner
  );

  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid in (
       'public.direct_entry_offboarding_authority(uuid,uuid)'::pg_catalog.regprocedure,
       'public.direct_entry__internal_offboarding_rows(uuid,uuid,text,uuid,boolean)'::pg_catalog.regprocedure,
       'public.direct_entry_offboarding_rows(uuid,uuid,text,uuid,boolean)'::pg_catalog.regprocedure,
       'public.direct_entry_offboarding_report(uuid,uuid,integer,integer)'::pg_catalog.regprocedure,
       'public.direct_entry_offboarding_report_export(uuid,uuid)'::pg_catalog.regprocedure,
       'public.direct_entry_offboarding_hide_snapshot(uuid,uuid,uuid,uuid,text,text)'::pg_catalog.regprocedure,
       'public.attendance_admin_report(uuid,uuid,date,date,integer,integer,text,uuid)'::pg_catalog.regprocedure,
       'public.attendance_admin_report(uuid,uuid,date,date,integer,integer,text)'::pg_catalog.regprocedure
     )
  loop
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_actor_mapping(uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_actor_app_user_admin(uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_capability(uuid,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_scope(uuid,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_authorization_date() to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_canonical_national_id(text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_is_canonical_national_id(text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_offboarding_authority(uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry__internal_offboarding_rows(uuid,uuid,text,uuid,boolean) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_offboarding_rows(uuid,uuid,text,uuid,boolean) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.attendance__internal_assert_report_reader(uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.attendance_admin_report(uuid,uuid,date,date,integer,integer,text,uuid) to %I',
      v_owner
    );
  end loop;
end;
$grant_hf_internal_owner_exec$;

-- -----------------------------------------------------------------------------
-- 5. Data-free install-time fail-closed self-check.
-- -----------------------------------------------------------------------------
do $check_hf_offboarding_and_attendance_filter$
declare
  v_sup_table constant pg_catalog.regclass :=
    'public.direct_entry_offboarding_suppressions'::pg_catalog.regclass;
  v_internal_sig text;
  v_rpc_sig text;
  v_rpc_oid pg_catalog.regprocedure;
  v_expected_vol "char";
  v_rls boolean;
  v_force_rls boolean;
  v_policy_count integer;
  v_exposed_table_acl integer;
  v_cccd_col_count integer;
  v_internal_rows_src text;
  v_hide_src text;
  v_secdef boolean;
  v_config text;
  v_vol "char";
  v_owner_bypasses_rls boolean;
begin
  select c.relrowsecurity,
         c.relforcerowsecurity,
         (select count(*)::integer from pg_catalog.pg_policy pol where pol.polrelid = c.oid),
         (select count(*)::integer
            from pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
           where a.grantee = 0
              or a.grantee in (
                'anon'::pg_catalog.regrole,
                'authenticated'::pg_catalog.regrole,
                'service_role'::pg_catalog.regrole
              )),
         (select count(*)::integer
            from pg_catalog.pg_attribute att
           where att.attrelid = c.oid
             and att.attnum > 0
             and not att.attisdropped
             and (att.attname ilike '%cccd%' or att.attname ilike '%national_id%'))
    into v_rls, v_force_rls, v_policy_count, v_exposed_table_acl, v_cccd_col_count
    from pg_catalog.pg_class c
   where c.oid = v_sup_table;

  if not coalesce(v_rls, false)
     or not coalesce(v_force_rls, false)
     or coalesce(v_policy_count, -1) <> 0
     or coalesce(v_exposed_table_acl, -1) <> 0
     or coalesce(v_cccd_col_count, -1) <> 0
     or pg_catalog.has_table_privilege('public', v_sup_table, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     or pg_catalog.has_table_privilege('anon', v_sup_table, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     or pg_catalog.has_table_privilege('authenticated', v_sup_table, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     or pg_catalog.has_table_privilege('service_role', v_sup_table, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
    raise exception 'Offboarding suppression table RLS/ACL/CCCD boundary drift'
      using errcode = '55000';
  end if;

  select p.prosrc into v_internal_rows_src
    from pg_catalog.pg_proc p
   where p.oid = 'public.direct_entry__internal_offboarding_rows(uuid,uuid,text,uuid,boolean)'::pg_catalog.regprocedure;
  select p.prosrc into v_hide_src
    from pg_catalog.pg_proc p
   where p.oid = 'public.direct_entry_offboarding_hide_snapshot(uuid,uuid,uuid,uuid,text,text)'::pg_catalog.regprocedure;

  if v_internal_rows_src is null
     or v_hide_src is null
     or pg_catalog.strpos(v_internal_rows_src, chr(39) || 'cccd' || chr(39)) > 0
     or pg_catalog.strpos(v_internal_rows_src, 'cccd_last4') > 0
     or pg_catalog.strpos(v_hide_src, chr(39) || 'cccd' || chr(39)) > 0
     or pg_catalog.strpos(v_hide_src, 'cccd_last4') > 0 then
    raise exception 'Offboarding functions must never project CCCD keys'
      using errcode = '55000';
  end if;

  foreach v_internal_sig in array array[
    'public.direct_entry__internal_offboarding_suppression_immutable()',
    'public.direct_entry_offboarding_authority(uuid,uuid)',
    'public.direct_entry__internal_offboarding_rows(uuid,uuid,text,uuid,boolean)',
    'public.direct_entry_offboarding_rows(uuid,uuid,text,uuid,boolean)'
  ]
  loop
    v_rpc_oid := pg_catalog.to_regprocedure(v_internal_sig);
    if pg_catalog.has_function_privilege('public', v_rpc_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_rpc_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_rpc_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_rpc_oid, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(
             (select p2.proacl from pg_catalog.pg_proc p2 where p2.oid = v_rpc_oid),
             pg_catalog.acldefault('f', (select p2.proowner from pg_catalog.pg_proc p2 where p2.oid = v_rpc_oid))
           )) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       ) then
      raise exception 'Internal helper must remain revoked from all runtime roles: %', v_internal_sig
        using errcode = '55000';
    end if;
  end loop;

  foreach v_rpc_sig in array array[
    'public.direct_entry_offboarding_report(uuid,uuid,integer,integer)',
    'public.direct_entry_offboarding_report_export(uuid,uuid)',
    'public.direct_entry_offboarding_hide_snapshot(uuid,uuid,uuid,uuid,text,text)',
    'public.attendance_admin_report(uuid,uuid,date,date,integer,integer,text,uuid)',
    'public.attendance_admin_report(uuid,uuid,date,date,integer,integer,text)'
  ]
  loop
    v_rpc_oid := pg_catalog.to_regprocedure(v_rpc_sig);
    v_expected_vol := case
      when v_rpc_sig = 'public.direct_entry_offboarding_hide_snapshot(uuid,uuid,uuid,uuid,text,text)'
        then 'v'::"char"
      else 's'::"char"
    end;

    select p.prosecdef,
           coalesce(pg_catalog.array_to_string(p.proconfig, ','), ''),
           p.provolatile,
           (r.rolsuper or r.rolbypassrls)
      into v_secdef, v_config, v_vol, v_owner_bypasses_rls
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_rpc_oid;

    if not coalesce(v_secdef, false)
       or v_config <> 'search_path=pg_catalog, public'
       or v_vol <> v_expected_vol
       or not coalesce(v_owner_bypasses_rls, false)
       or pg_catalog.has_function_privilege('public', v_rpc_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_rpc_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_rpc_oid, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(
             (select p2.proacl from pg_catalog.pg_proc p2 where p2.oid = v_rpc_oid),
             pg_catalog.acldefault('f', (select p2.proowner from pg_catalog.pg_proc p2 where p2.oid = v_rpc_oid))
           )) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
       or not pg_catalog.has_function_privilege('service_role', v_rpc_oid, 'EXECUTE') then
      raise exception 'Service-role RPC security boundary drift on %', v_rpc_sig
        using errcode = '55000';
    end if;
  end loop;
end;
$check_hf_offboarding_and_attendance_filter$;

commit;
