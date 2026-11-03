-- Wave 2: Attendance Explanations (Giải trình chấm công) & Monthly Report Integration
-- Forward-only migration:
--   1. Creates attendance_explanations, attendance_explanation_audit_events, and
--      attendance_explanation_idempotency_records with forced RLS and default-deny ACLs.
--   2. Reuses Leave Management's exact approver routing and authority resolution
--      (leave_management__internal_resolve_authority, leave_management__internal_resolve_routing,
--       leave_management__internal_can_actor_decide_request, leave_management__internal_account_summary).
--   3. Adds employee explanation overview/submission RPCs and approver inbox/decision RPCs.
--   4. Updates attendance_monthly_matrix_report so each day slot includes explanation
--      metadata and marks approved explanations as slot_status = 'EXPLAINED_APPROVED'
--      without mutating attendance_checkins or leave balances.

begin;

-- =============================================================================
-- SECTION 1: Tables, Constraints, Indexes, Triggers & Default-Deny RLS
-- =============================================================================

create table if not exists public.attendance_explanations (
  explanation_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references public.direct_entry_app_users(app_user_id),
  business_date date not null,
  slot_code text not null,
  slot_index integer not null,
  slot_label text not null,
  session_code text not null
    check (session_code in ('AM', 'PM')),
  target_time text not null
    check (target_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  grace_before_minutes integer not null
    check (grace_before_minutes >= 0 and grace_before_minutes <= 720),
  grace_after_minutes integer not null
    check (grace_after_minutes >= 0 and grace_after_minutes <= 720),
  policy_version_used integer not null
    check (policy_version_used >= 1),
  original_slot_status text not null
    check (original_slot_status in ('MISSING', 'OUT_OF_GRACE')),
  related_checkins_snapshot jsonb not null default '[]'::jsonb
    check (jsonb_typeof(related_checkins_snapshot) = 'array'),
  reason text not null
    check (
      char_length(btrim(reason)) between 3 and 500
      and reason !~ '[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]'
    ),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  unit_kind_snapshot text null
    check (
      unit_kind_snapshot is null or unit_kind_snapshot in (
        'UNCLASSIFIED',
        'RECRUITMENT',
        'MARKETING',
        'IT',
        'ACCOUNTING',
        'MANAGEMENT_BOD',
        'LEGAL_ADMIN'
      )
    ),
  route_kind text not null
    check (route_kind in (
      'TEAM_LEADER',
      'DEPARTMENT_HEAD',
      'ADMIN_BOD_DIRECT',
      'ADMIN_BOD_FALLBACK',
      'RECRUITMENT_TEAM_LEADER',
      'RECRUITMENT_HEAD',
      'ACCOUNTING_HEAD',
      'LEGAL_ADMIN_HEAD',
      'BOD_DIRECT'
    )),
  primary_approver_app_user_id uuid null references public.direct_entry_app_users(app_user_id),
  routed_team_id uuid null references public.teams(team_id),
  routed_team_code text null,
  routed_team_name text null,
  fallback_reason text null,
  submitted_at timestamptz not null default now(),
  decided_at timestamptz null,
  decided_by_app_user_id uuid null references public.direct_entry_app_users(app_user_id),
  decision_note text not null default ''
    check (
      char_length(decision_note) <= 500
      and decision_note !~ '[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]'
    ),
  row_version integer not null default 1
    check (row_version >= 1),
  updated_at timestamptz not null default now(),
  check (
    slot_index between 1 and 12
    and slot_code = ('SLOT_' || slot_index::text)
  ),
  check (
    char_length(btrim(slot_label)) between 1 and 64
    and slot_label !~ '[\u0000-\u001f\u007f]'
  ),
  check (
    (status = 'PENDING' and decided_at is null and decided_by_app_user_id is null)
    or (status in ('APPROVED', 'REJECTED') and decided_at is not null and decided_by_app_user_id is not null)
  ),
  check (
    decided_by_app_user_id is null
    or decided_by_app_user_id <> app_user_id
  )
);

create unique index if not exists attendance_explanations_active_slot_uq
  on public.attendance_explanations (app_user_id, business_date, slot_code)
  where status in ('PENDING', 'APPROVED');

create index if not exists attendance_explanations_user_date_idx
  on public.attendance_explanations (app_user_id, business_date desc, slot_index asc, submitted_at desc);

create index if not exists attendance_explanations_status_submitted_idx
  on public.attendance_explanations (status, submitted_at desc, explanation_id desc);

create index if not exists attendance_explanations_primary_approver_idx
  on public.attendance_explanations (primary_approver_app_user_id, status, submitted_at desc)
  where primary_approver_app_user_id is not null;

create table if not exists public.attendance_explanation_audit_events (
  audit_event_id uuid primary key default gen_random_uuid(),
  explanation_id uuid not null references public.attendance_explanations(explanation_id),
  action text not null
    check (action in ('SUBMITTED', 'APPROVED', 'REJECTED')),
  actor_app_user_id uuid not null references public.direct_entry_app_users(app_user_id),
  before_status text null,
  after_status text not null
    check (after_status in ('PENDING', 'APPROVED', 'REJECTED')),
  note text not null default ''
    check (char_length(note) <= 500),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists attendance_explanation_audit_events_explanation_idx
  on public.attendance_explanation_audit_events (explanation_id, created_at asc, audit_event_id asc);

drop trigger if exists trg_attendance_explanation_audit_events_immutable
  on public.attendance_explanation_audit_events;
create trigger trg_attendance_explanation_audit_events_immutable
  before update or delete on public.attendance_explanation_audit_events
  for each row execute function public.leave_management__internal_immutable_guard();

create table if not exists public.attendance_explanation_idempotency_records (
  app_user_id uuid not null references public.direct_entry_app_users(app_user_id),
  operation text not null
    check (operation in ('explanation_submit', 'explanation_decide')),
  idempotency_key text not null
    check (char_length(btrim(idempotency_key)) between 8 and 128),
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  response_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (app_user_id, operation, idempotency_key)
);

drop trigger if exists trg_attendance_explanation_idempotency_immutable
  on public.attendance_explanation_idempotency_records;
create trigger trg_attendance_explanation_idempotency_immutable
  before update or delete on public.attendance_explanation_idempotency_records
  for each row execute function public.leave_management__internal_immutable_guard();

alter table public.attendance_explanations enable row level security;
alter table public.attendance_explanations force row level security;
revoke all on table public.attendance_explanations
  from public, anon, authenticated, service_role;

alter table public.attendance_explanation_audit_events enable row level security;
alter table public.attendance_explanation_audit_events force row level security;
revoke all on table public.attendance_explanation_audit_events
  from public, anon, authenticated, service_role;

alter table public.attendance_explanation_idempotency_records enable row level security;
alter table public.attendance_explanation_idempotency_records force row level security;
revoke all on table public.attendance_explanation_idempotency_records
  from public, anon, authenticated, service_role;

-- =============================================================================
-- SECTION 2: Internal Helpers (Reusing Leave Management Routing & Authority)
-- =============================================================================

create or replace function public.attendance_explanation__internal_can_actor_decide(
  p_actor_app_user_id uuid,
  p_explanation public.attendance_explanations,
  p_as_of date default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_leave_req public.leave_requests%rowtype;
begin
  -- Delegate directly to Leave Management's canonical decision-authority helper so
  -- whoever is authorized to approve leave for the requester has identical authority
  -- to approve/reject their attendance explanation.
  v_leave_req.request_id := p_explanation.explanation_id;
  v_leave_req.app_user_id := p_explanation.app_user_id;
  v_leave_req.unit_kind_snapshot := p_explanation.unit_kind_snapshot;
  v_leave_req.route_kind := p_explanation.route_kind;
  v_leave_req.primary_approver_app_user_id := p_explanation.primary_approver_app_user_id;
  v_leave_req.routed_team_id := p_explanation.routed_team_id;
  v_leave_req.routed_team_code := p_explanation.routed_team_code;
  v_leave_req.routed_team_name := p_explanation.routed_team_name;
  v_leave_req.fallback_reason := p_explanation.fallback_reason;

  return public.leave_management__internal_can_actor_decide_request(
    p_actor_app_user_id,
    v_leave_req,
    p_as_of
  );
end;
$$;

create or replace function public.attendance_explanation__internal_evaluate_employee_day_slots(
  p_app_user_id uuid,
  p_business_date date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_today_local date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_policy public.attendance_slot_policy_versions%rowtype;
  v_slots jsonb;
begin
  if p_app_user_id is null or p_business_date is null then
    raise exception 'ATTENDANCE_EXPLANATION_QUERY_INVALID'
      using errcode = '22023';
  end if;

  select p.*
    into v_policy
  from public.attendance_slot_policy_versions p
  where p.effective_from_date <= p_business_date
  order by p.effective_from_date desc, p.version desc
  limit 1;

  if not found then
    select p.*
      into v_policy
    from public.attendance_slot_policy_versions p
    order by p.version asc
    limit 1;
  end if;

  with slot_defs as (
    select
      (slot_elem->>'slot_index')::integer as slot_index,
      slot_elem->>'slot_code' as slot_code,
      coalesce(
        nullif(btrim(coalesce(slot_elem->>'slot_label', '')), ''),
        'Time ' || (slot_elem->>'slot_index')
      ) as slot_label,
      slot_elem->>'session_code' as session_code,
      slot_elem->>'target_time' as target_time,
      (
        split_part(slot_elem->>'target_time', ':', 1)::integer * 60
        + split_part(slot_elem->>'target_time', ':', 2)::integer
      ) as target_minute,
      (slot_elem->>'grace_before_minutes')::integer as grace_before_minutes,
      (slot_elem->>'grace_after_minutes')::integer as grace_after_minutes
    from jsonb_array_elements(v_policy.slots) as slot_elem
  ),
  raw_checkins as (
    select
      c.checkin_id,
      c.sequence_in_day,
      c.captured_at,
      to_char(c.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as captured_at_utc,
      to_char(c.captured_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') as captured_at_local,
      to_char(c.captured_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI') as time_local,
      (
        extract(hour from (c.captured_at at time zone 'Asia/Ho_Chi_Minh'))::integer * 60
        + extract(minute from (c.captured_at at time zone 'Asia/Ho_Chi_Minh'))::integer
      ) as local_minute_of_day,
      c.time_verified,
      case
        when c.distance_status is not null then coalesce(c.distance_target_kind, case when c.branch_id_used is not null then 'BRANCH' else 'HQ' end)
        else 'HQ'
      end as distance_target_kind,
      case
        when c.distance_status is not null then c.distance_status
        when c.accuracy_meters > 100000.0 then 'INVALID_GPS'
        when hq.version is null then 'HQ_NOT_CONFIGURED'
        else 'COMPUTED'
      end as distance_status,
      case
        when c.distance_status is not null then c.distance_meters
        when c.accuracy_meters > 100000.0 or hq.version is null then null
        else round(
          (
            2.0 * 6371000.0 * asin(
              least(
                1.0::double precision,
                sqrt(
                  greatest(
                    0.0::double precision,
                    power(sin(radians(c.latitude - hq.latitude) / 2.0), 2)
                    + cos(radians(hq.latitude))
                      * cos(radians(c.latitude))
                      * power(sin(radians(c.longitude - hq.longitude) / 2.0), 2)
                  )
                )
              )
            )
          )::numeric,
          1
        )::double precision
      end as distance_meters
    from public.attendance_checkins c
    left join lateral (
      select
        r.version,
        r.latitude,
        r.longitude
      from public.attendance_hq_location_revisions r
      where c.distance_status is null
        and r.effective_from <= (
          case
            when c.time_verified then c.captured_at
            else c.received_at
          end
        )
      order by r.effective_from desc, r.version desc
      limit 1
    ) hq on true
    where c.app_user_id = p_app_user_id
      and c.business_date = p_business_date
  ),
  enriched_checkins as (
    select
      rc.*,
      ns.slot_index as assigned_slot_index,
      ns.slot_code as assigned_slot_code,
      (rc.local_minute_of_day - ns.target_minute)::integer as delta_minutes,
      case
        when (rc.local_minute_of_day - ns.target_minute) < (-ns.grace_before_minutes) then
          ((- (rc.local_minute_of_day - ns.target_minute)) - ns.grace_before_minutes)::integer
        when (rc.local_minute_of_day - ns.target_minute) > ns.grace_after_minutes then
          ((rc.local_minute_of_day - ns.target_minute) - ns.grace_after_minutes)::integer
        else 0
      end as over_grace_minutes,
      case
        when (rc.local_minute_of_day - ns.target_minute) < (-ns.grace_before_minutes) then 'EARLY'
        when (rc.local_minute_of_day - ns.target_minute) > ns.grace_after_minutes then 'LATE'
        else 'ON_TIME'
      end as deviation_status
    from raw_checkins rc
    cross join lateral (
      select
        s.slot_index,
        s.slot_code,
        s.target_minute,
        s.grace_before_minutes,
        s.grace_after_minutes
      from slot_defs s
      order by abs(rc.local_minute_of_day - s.target_minute) asc, s.slot_index asc
      limit 1
    ) ns
  ),
  slot_checkins as (
    select
      ec.assigned_slot_index as slot_index,
      count(*)::integer as checkin_count,
      count(*) filter (where ec.deviation_status <> 'ON_TIME')::integer as out_of_grace_count,
      jsonb_agg(
        jsonb_build_object(
          'checkin_id', ec.checkin_id,
          'sequence_in_day', ec.sequence_in_day,
          'captured_at', ec.captured_at_utc,
          'captured_at_local', ec.captured_at_local,
          'time_local', ec.time_local,
          'time_verified', ec.time_verified,
          'assigned_slot_code', ec.assigned_slot_code,
          'delta_minutes', ec.delta_minutes,
          'over_grace_minutes', ec.over_grace_minutes,
          'deviation_status', ec.deviation_status,
          'distance_target_kind', ec.distance_target_kind,
          'distance_status', ec.distance_status,
          'distance_meters', ec.distance_meters
        )
        order by ec.captured_at asc, ec.sequence_in_day asc, ec.checkin_id asc
      ) as checkins
    from enriched_checkins ec
    group by ec.assigned_slot_index
  ),
  leave_coverage as (
    select
      coalesce(bool_or(ld.session_code in ('FULL', 'AM')), false) as am_covered,
      coalesce(bool_or(ld.session_code in ('FULL', 'PM')), false) as pm_covered
    from public.leave_request_days ld
    join public.leave_requests lr
      on lr.request_id = ld.request_id
    where ld.app_user_id = p_app_user_id
      and ld.leave_date = p_business_date
      and ld.is_active = true
      and lr.status = 'APPROVED'
  ),
  slot_explanations as (
    select distinct on (ae.slot_code)
      ae.explanation_id,
      ae.slot_code,
      ae.status,
      ae.original_slot_status,
      ae.reason,
      to_char(ae.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as submitted_at_utc,
      to_char(ae.submitted_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') as submitted_at_local,
      case
        when ae.decided_at is not null then
          to_char(ae.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        else null
      end as decided_at_utc,
      case
        when ae.decided_at is not null then
          to_char(ae.decided_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS')
        else null
      end as decided_at_local,
      du.display_name as decided_by_display_name,
      ae.decision_note,
      ae.row_version
    from public.attendance_explanations ae
    left join public.direct_entry_app_users du
      on du.app_user_id = ae.decided_by_app_user_id
    where ae.app_user_id = p_app_user_id
      and ae.business_date = p_business_date
    order by
      ae.slot_code asc,
      case ae.status
        when 'APPROVED' then 1
        when 'PENDING' then 2
        else 3
      end asc,
      ae.submitted_at desc,
      ae.explanation_id desc
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'slot_code', sd.slot_code,
        'slot_index', sd.slot_index,
        'slot_label', sd.slot_label,
        'session_code', sd.session_code,
        'target_time', sd.target_time,
        'grace_before_minutes', sd.grace_before_minutes,
        'grace_after_minutes', sd.grace_after_minutes,
        'is_leave_covered', (
          case
            when sd.session_code = 'AM' then lc.am_covered
            else lc.pm_covered
          end
        ),
        'original_slot_status', (
          case
            when coalesce(sc.checkin_count, 0) > 0 and coalesce(sc.out_of_grace_count, 0) > 0 then 'OUT_OF_GRACE'
            when coalesce(sc.checkin_count, 0) > 0 then 'ON_TIME'
            when (
              case
                when sd.session_code = 'AM' then lc.am_covered
                else lc.pm_covered
              end
            ) then 'LEAVE_COVERED'
            else 'MISSING'
          end
        ),
        'slot_status', (
          case
            when se.status = 'APPROVED' and (
              (coalesce(sc.checkin_count, 0) > 0 and coalesce(sc.out_of_grace_count, 0) > 0)
              or (
                coalesce(sc.checkin_count, 0) = 0
                and not (
                  case
                    when sd.session_code = 'AM' then lc.am_covered
                    else lc.pm_covered
                  end
                )
              )
            ) then 'EXPLAINED_APPROVED'
            when coalesce(sc.checkin_count, 0) > 0 and coalesce(sc.out_of_grace_count, 0) > 0 then 'OUT_OF_GRACE'
            when coalesce(sc.checkin_count, 0) > 0 then 'ON_TIME'
            when (
              case
                when sd.session_code = 'AM' then lc.am_covered
                else lc.pm_covered
              end
            ) then 'LEAVE_COVERED'
            else 'MISSING'
          end
        ),
        'eligible_for_explanation', (
          p_business_date <= v_today_local
          and coalesce(se.status, '') not in ('PENDING', 'APPROVED')
          and (
            (coalesce(sc.checkin_count, 0) > 0 and coalesce(sc.out_of_grace_count, 0) > 0)
            or (
              coalesce(sc.checkin_count, 0) = 0
              and not (
                case
                  when sd.session_code = 'AM' then lc.am_covered
                  else lc.pm_covered
                end
              )
            )
          )
        ),
        'checkins', coalesce(sc.checkins, '[]'::jsonb),
        'explanation', case
          when se.explanation_id is not null then
            jsonb_build_object(
              'explanation_id', se.explanation_id,
              'status', se.status,
              'original_slot_status', se.original_slot_status,
              'reason', se.reason,
              'submitted_at', se.submitted_at_utc,
              'submitted_at_local', se.submitted_at_local,
              'decided_at', se.decided_at_utc,
              'decided_at_local', se.decided_at_local,
              'decided_by_display_name', se.decided_by_display_name,
              'decision_note', se.decision_note,
              'row_version', se.row_version
            )
          else null
        end
      )
      order by sd.slot_index asc
    ),
    '[]'::jsonb
  )
    into v_slots
  from slot_defs sd
  cross join leave_coverage lc
  left join slot_checkins sc
    on sc.slot_index = sd.slot_index
  left join slot_explanations se
    on se.slot_code = sd.slot_code;

  return jsonb_build_object(
    'business_date', p_business_date::text,
    'policy_version_used', v_policy.version,
    'slots', v_slots
  );
end;
$$;

create or replace function public.attendance_explanation__internal_project_item(
  p_explanation public.attendance_explanations
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_requester jsonb;
  v_primary_approver jsonb := null;
  v_decided_by jsonb := null;
  v_audit_events jsonb := '[]'::jsonb;
begin
  v_requester := public.leave_management__internal_account_summary(p_explanation.app_user_id);

  if p_explanation.primary_approver_app_user_id is not null then
    v_primary_approver := public.leave_management__internal_account_summary(
      p_explanation.primary_approver_app_user_id
    );
  end if;

  if p_explanation.decided_by_app_user_id is not null then
    v_decided_by := public.leave_management__internal_account_summary(
      p_explanation.decided_by_app_user_id
    );
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'audit_event_id', e.audit_event_id,
        'action', e.action,
        'actor', public.leave_management__internal_account_summary(e.actor_app_user_id),
        'before_status', e.before_status,
        'after_status', e.after_status,
        'note', e.note,
        'created_at', to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'created_at_local', to_char(e.created_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS')
      )
      order by e.created_at asc, e.audit_event_id asc
    ),
    '[]'::jsonb
  )
    into v_audit_events
  from public.attendance_explanation_audit_events e
  where e.explanation_id = p_explanation.explanation_id;

  return jsonb_build_object(
    'explanation_id', p_explanation.explanation_id,
    'app_user_id', p_explanation.app_user_id,
    'requester', v_requester,
    'business_date', p_explanation.business_date::text,
    'slot_code', p_explanation.slot_code,
    'slot_index', p_explanation.slot_index,
    'slot_label', p_explanation.slot_label,
    'session_code', p_explanation.session_code,
    'target_time', p_explanation.target_time,
    'grace_before_minutes', p_explanation.grace_before_minutes,
    'grace_after_minutes', p_explanation.grace_after_minutes,
    'policy_version_used', p_explanation.policy_version_used,
    'original_slot_status', p_explanation.original_slot_status,
    'effective_slot_status', case
      when p_explanation.status = 'APPROVED' then 'EXPLAINED_APPROVED'
      else p_explanation.original_slot_status
    end,
    'related_checkins', p_explanation.related_checkins_snapshot,
    'reason', p_explanation.reason,
    'status', p_explanation.status,
    'unit_kind_snapshot', p_explanation.unit_kind_snapshot,
    'route_kind', p_explanation.route_kind,
    'primary_approver', v_primary_approver,
    'routed_team', case
      when p_explanation.routed_team_id is not null then
        jsonb_build_object(
          'team_id', p_explanation.routed_team_id,
          'team_code', p_explanation.routed_team_code,
          'team_name', p_explanation.routed_team_name
        )
      else null
    end,
    'fallback_reason', p_explanation.fallback_reason,
    'submitted_at', to_char(p_explanation.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'submitted_at_local', to_char(p_explanation.submitted_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS'),
    'decided_at', case
      when p_explanation.decided_at is not null then
        to_char(p_explanation.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      else null
    end,
    'decided_at_local', case
      when p_explanation.decided_at is not null then
        to_char(p_explanation.decided_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS')
      else null
    end,
    'decided_by', v_decided_by,
    'decision_note', p_explanation.decision_note,
    'row_version', p_explanation.row_version,
    'updated_at', to_char(p_explanation.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'audit_events', v_audit_events
  );
end;
$$;

-- =============================================================================
-- SECTION 3: Employee & Approver Explanation RPCs
-- =============================================================================

create or replace function public.attendance_get_my_explanations_overview(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_business_date date default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_auth jsonb;
  v_today_local date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_selected_date date := coalesce(p_business_date, v_today_local);
  v_limit integer := coalesce(p_limit, 50);
  v_offset integer := coalesce(p_offset, 0);
  v_routing jsonb;
  v_primary_approver_id uuid;
  v_day_evaluation jsonb;
  v_total_rows integer := 0;
  v_items jsonb := '[]'::jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(
    p_actor_auth_subject,
    p_actor_app_user_id
  );

  if v_selected_date < date '2000-01-01' or v_selected_date > date '2100-12-31' then
    raise exception 'ATTENDANCE_EXPLANATION_DATE_INVALID'
      using errcode = '22023';
  end if;

  if v_limit < 1 or v_limit > 200 or v_offset < 0 then
    raise exception 'ATTENDANCE_EXPLANATION_PAGINATION_INVALID'
      using errcode = '22023';
  end if;

  v_routing := public.leave_management__internal_resolve_routing(
    p_actor_app_user_id,
    v_today_local
  );

  if (v_routing ->> 'primary_approver_app_user_id') is not null then
    v_primary_approver_id := (v_routing ->> 'primary_approver_app_user_id')::uuid;
  end if;

  v_day_evaluation := public.attendance_explanation__internal_evaluate_employee_day_slots(
    p_actor_app_user_id,
    v_selected_date
  );

  select count(*)::integer
    into v_total_rows
  from public.attendance_explanations ae
  where ae.app_user_id = p_actor_app_user_id;

  select coalesce(
    jsonb_agg(
      public.attendance_explanation__internal_project_item(s.row_data)
      order by s.submitted_at desc, s.explanation_id desc
    ),
    '[]'::jsonb
  )
    into v_items
  from (
    select ae as row_data, ae.submitted_at, ae.explanation_id
    from public.attendance_explanations ae
    where ae.app_user_id = p_actor_app_user_id
    order by ae.submitted_at desc, ae.explanation_id desc
    limit v_limit
    offset v_offset
  ) s;

  return jsonb_build_object(
    'viewer', jsonb_build_object(
      'app_user_id', p_actor_app_user_id,
      'can_submit_explanation', (v_auth ->> 'can_submit_request')::boolean,
      'can_approve_explanations', (v_auth ->> 'can_approve_requests')::boolean,
      'is_shared_non_employee', (v_auth ->> 'is_shared_non_employee')::boolean,
      'is_full_admin', (v_auth ->> 'is_full_admin')::boolean,
      'is_bod', (v_auth ->> 'is_bod')::boolean
    ),
    'routing', jsonb_build_object(
      'route_kind', v_routing ->> 'route_kind',
      'unit_kind', v_routing ->> 'unit_kind',
      'primary_approver', case
        when v_primary_approver_id is not null then
          public.leave_management__internal_account_summary(v_primary_approver_id)
        else null
      end,
      'team_id', v_routing ->> 'team_id',
      'team_code', v_routing ->> 'team_code',
      'team_name', v_routing ->> 'team_name',
      'fallback_reason', v_routing ->> 'fallback_reason',
      'profile_configured', (v_routing ->> 'profile_configured')::boolean
    ),
    'today_local', v_today_local::text,
    'selected_date', v_selected_date::text,
    'day_evaluation', v_day_evaluation,
    'pagination', jsonb_build_object(
      'limit', v_limit,
      'offset', v_offset,
      'total_rows', v_total_rows
    ),
    'items', v_items
  );
end;
$$;

create or replace function public.attendance_submit_explanation(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_business_date date,
  p_slot_code text,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_auth jsonb;
  v_today_local date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_slot_code text := upper(btrim(coalesce(p_slot_code, '')));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_idempotency_key text := btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := lower(btrim(coalesce(p_request_fingerprint, '')));
  v_existing_idem public.attendance_explanation_idempotency_records%rowtype;
  v_day_evaluation jsonb;
  v_policy_version_used integer;
  v_slot_eval jsonb;
  v_original_slot_status text;
  v_routing jsonb;
  v_inserted public.attendance_explanations%rowtype;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(
    p_actor_auth_subject,
    p_actor_app_user_id
  );

  if not (v_auth ->> 'can_submit_request')::boolean then
    raise exception 'ATTENDANCE_EXPLANATION_SUBMIT_DENIED'
      using errcode = '42501';
  end if;

  if char_length(v_idempotency_key) < 8
     or char_length(v_idempotency_key) > 128
     or v_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('attendance_explanation_submit:' || p_actor_app_user_id::text),
    hashtext(coalesce(p_business_date::text, '') || ':' || v_slot_code)
  );

  select *
    into v_existing_idem
  from public.attendance_explanation_idempotency_records r
  where r.app_user_id = p_actor_app_user_id
    and r.operation = 'explanation_submit'
    and r.idempotency_key = v_idempotency_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = 'PT409';
    end if;
    return jsonb_set(v_existing_idem.response_payload, '{replayed}', 'true'::jsonb, true);
  end if;

  if p_business_date is null
     or p_business_date < date '2000-01-01'
     or p_business_date > date '2100-12-31' then
    raise exception 'ATTENDANCE_EXPLANATION_DATE_INVALID'
      using errcode = '22023';
  end if;

  if p_business_date > v_today_local then
    raise exception 'ATTENDANCE_EXPLANATION_FUTURE_DATE_NOT_ALLOWED'
      using errcode = '22023';
  end if;

  if v_slot_code !~ '^SLOT_([1-9]|1[0-2])$' then
    raise exception 'ATTENDANCE_EXPLANATION_SLOT_INVALID'
      using errcode = '22023';
  end if;

  if char_length(v_reason) < 3
     or char_length(v_reason) > 500
     or v_reason ~ '[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]' then
    raise exception 'ATTENDANCE_EXPLANATION_REASON_INVALID'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.attendance_explanations ae
    where ae.app_user_id = p_actor_app_user_id
      and ae.business_date = p_business_date
      and ae.slot_code = v_slot_code
      and ae.status in ('PENDING', 'APPROVED')
  ) then
    raise exception 'ATTENDANCE_EXPLANATION_ALREADY_EXISTS'
      using errcode = 'PT409';
  end if;

  v_day_evaluation := public.attendance_explanation__internal_evaluate_employee_day_slots(
    p_actor_app_user_id,
    p_business_date
  );
  v_policy_version_used := (v_day_evaluation ->> 'policy_version_used')::integer;

  select elem
    into v_slot_eval
  from jsonb_array_elements(v_day_evaluation -> 'slots') as elem
  where elem ->> 'slot_code' = v_slot_code
  limit 1;

  if v_slot_eval is null then
    raise exception 'ATTENDANCE_EXPLANATION_SLOT_INVALID'
      using errcode = '22023';
  end if;

  v_original_slot_status := v_slot_eval ->> 'original_slot_status';
  if v_original_slot_status not in ('MISSING', 'OUT_OF_GRACE') then
    raise exception 'ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE'
      using errcode = 'PT409';
  end if;

  v_routing := public.leave_management__internal_resolve_routing(
    p_actor_app_user_id,
    v_today_local
  );

  insert into public.attendance_explanations (
    app_user_id,
    business_date,
    slot_code,
    slot_index,
    slot_label,
    session_code,
    target_time,
    grace_before_minutes,
    grace_after_minutes,
    policy_version_used,
    original_slot_status,
    related_checkins_snapshot,
    reason,
    status,
    unit_kind_snapshot,
    route_kind,
    primary_approver_app_user_id,
    routed_team_id,
    routed_team_code,
    routed_team_name,
    fallback_reason,
    submitted_at,
    row_version,
    updated_at
  )
  values (
    p_actor_app_user_id,
    p_business_date,
    v_slot_code,
    (v_slot_eval ->> 'slot_index')::integer,
    v_slot_eval ->> 'slot_label',
    v_slot_eval ->> 'session_code',
    v_slot_eval ->> 'target_time',
    (v_slot_eval ->> 'grace_before_minutes')::integer,
    (v_slot_eval ->> 'grace_after_minutes')::integer,
    v_policy_version_used,
    v_original_slot_status,
    coalesce(v_slot_eval -> 'checkins', '[]'::jsonb),
    v_reason,
    'PENDING',
    v_routing ->> 'unit_kind',
    v_routing ->> 'route_kind',
    case
      when (v_routing ->> 'primary_approver_app_user_id') is not null then
        (v_routing ->> 'primary_approver_app_user_id')::uuid
      else null
    end,
    case
      when (v_routing ->> 'team_id') is not null then
        (v_routing ->> 'team_id')::uuid
      else null
    end,
    v_routing ->> 'team_code',
    v_routing ->> 'team_name',
    v_routing ->> 'fallback_reason',
    clock_timestamp(),
    1,
    clock_timestamp()
  )
  returning * into v_inserted;

  insert into public.attendance_explanation_audit_events (
    explanation_id,
    action,
    actor_app_user_id,
    before_status,
    after_status,
    note,
    payload
  )
  values (
    v_inserted.explanation_id,
    'SUBMITTED',
    p_actor_app_user_id,
    null,
    'PENDING',
    v_reason,
    jsonb_build_object(
      'business_date', p_business_date::text,
      'slot_code', v_slot_code,
      'policy_version_used', v_policy_version_used,
      'original_slot_status', v_original_slot_status,
      'route_kind', v_inserted.route_kind,
      'primary_approver_app_user_id', v_inserted.primary_approver_app_user_id
    )
  );

  v_response := jsonb_build_object(
    'replayed', false,
    'explanation', public.attendance_explanation__internal_project_item(v_inserted)
  );

  insert into public.attendance_explanation_idempotency_records (
    app_user_id,
    operation,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    p_actor_app_user_id,
    'explanation_submit',
    v_idempotency_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$$;

create or replace function public.attendance_list_explanation_approval_inbox(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_status_filter text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_auth jsonb;
  v_today_local date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_status text := nullif(upper(btrim(coalesce(p_status_filter, ''))), '');
  v_limit integer := coalesce(p_limit, 50);
  v_offset integer := coalesce(p_offset, 0);
  v_total_rows integer := 0;
  v_pending_count integer := 0;
  v_items jsonb := '[]'::jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(
    p_actor_auth_subject,
    p_actor_app_user_id
  );

  if not (v_auth ->> 'can_approve_requests')::boolean then
    raise exception 'ATTENDANCE_EXPLANATION_APPROVAL_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if v_status is not null and v_status not in ('ALL', 'PENDING', 'APPROVED', 'REJECTED') then
    raise exception 'ATTENDANCE_EXPLANATION_FILTER_INVALID'
      using errcode = '22023';
  end if;

  if v_limit < 1 or v_limit > 200 or v_offset < 0 then
    raise exception 'ATTENDANCE_EXPLANATION_PAGINATION_INVALID'
      using errcode = '22023';
  end if;

  select count(*)::integer
    into v_pending_count
  from public.attendance_explanations ae
  where ae.status = 'PENDING'
    and public.attendance_explanation__internal_can_actor_decide(
      p_actor_app_user_id,
      ae,
      v_today_local
    );

  select count(*)::integer
    into v_total_rows
  from public.attendance_explanations ae
  where (v_status is null or v_status = 'ALL' or ae.status = v_status)
    and (
      public.attendance_explanation__internal_can_actor_decide(
        p_actor_app_user_id,
        ae,
        v_today_local
      )
      or ae.decided_by_app_user_id = p_actor_app_user_id
    );

  select coalesce(
    jsonb_agg(
      public.attendance_explanation__internal_project_item(s.row_data)
      || jsonb_build_object('can_decide', s.can_decide)
      order by
        case when (s.row_data).status = 'PENDING' then 0 else 1 end asc,
        (s.row_data).submitted_at desc,
        (s.row_data).explanation_id desc
    ),
    '[]'::jsonb
  )
    into v_items
  from (
    select
      ae as row_data,
      (
        ae.status = 'PENDING'
        and public.attendance_explanation__internal_can_actor_decide(
          p_actor_app_user_id,
          ae,
          v_today_local
        )
      ) as can_decide
    from public.attendance_explanations ae
    where (v_status is null or v_status = 'ALL' or ae.status = v_status)
      and (
        public.attendance_explanation__internal_can_actor_decide(
          p_actor_app_user_id,
          ae,
          v_today_local
        )
        or ae.decided_by_app_user_id = p_actor_app_user_id
      )
    order by
      case when ae.status = 'PENDING' then 0 else 1 end asc,
      ae.submitted_at desc,
      ae.explanation_id desc
    limit v_limit
    offset v_offset
  ) s;

  return jsonb_build_object(
    'viewer', jsonb_build_object(
      'app_user_id', p_actor_app_user_id,
      'can_approve_explanations', true,
      'is_full_admin', (v_auth ->> 'is_full_admin')::boolean,
      'is_bod', (v_auth ->> 'is_bod')::boolean
    ),
    'pagination', jsonb_build_object(
      'limit', v_limit,
      'offset', v_offset,
      'total_rows', v_total_rows,
      'pending_count', v_pending_count
    ),
    'items', v_items
  );
end;
$$;

create or replace function public.attendance_decide_explanation(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_explanation_id uuid,
  p_decision text,
  p_expected_row_version integer,
  p_decision_note text default '',
  p_idempotency_key text default null,
  p_request_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_auth jsonb;
  v_today_local date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_decision text := upper(btrim(coalesce(p_decision, '')));
  v_note text := btrim(coalesce(p_decision_note, ''));
  v_idempotency_key text := btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := lower(btrim(coalesce(p_request_fingerprint, '')));
  v_existing_idem public.attendance_explanation_idempotency_records%rowtype;
  v_row public.attendance_explanations%rowtype;
  v_next_status text;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(
    p_actor_auth_subject,
    p_actor_app_user_id
  );

  if not (v_auth ->> 'can_approve_requests')::boolean then
    raise exception 'ATTENDANCE_EXPLANATION_DECIDE_DENIED'
      using errcode = '42501';
  end if;

  if char_length(v_idempotency_key) < 8
     or char_length(v_idempotency_key) > 128
     or v_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('attendance_explanation_decide'),
    hashtext(coalesce(p_explanation_id::text, ''))
  );

  select *
    into v_existing_idem
  from public.attendance_explanation_idempotency_records r
  where r.app_user_id = p_actor_app_user_id
    and r.operation = 'explanation_decide'
    and r.idempotency_key = v_idempotency_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = 'PT409';
    end if;
    return jsonb_set(v_existing_idem.response_payload, '{replayed}', 'true'::jsonb, true);
  end if;

  if p_explanation_id is null
     or v_decision not in ('APPROVE', 'REJECT')
     or p_expected_row_version is null
     or p_expected_row_version < 1 then
    raise exception 'ATTENDANCE_EXPLANATION_DECISION_INVALID'
      using errcode = '22023';
  end if;

  if char_length(v_note) > 500
     or v_note ~ '[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]' then
    raise exception 'ATTENDANCE_EXPLANATION_NOTE_INVALID'
      using errcode = '22023';
  end if;

  select *
    into v_row
  from public.attendance_explanations ae
  where ae.explanation_id = p_explanation_id
  for update;

  if not found then
    raise exception 'ATTENDANCE_EXPLANATION_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_row.app_user_id = p_actor_app_user_id then
    raise exception 'ATTENDANCE_EXPLANATION_SELF_APPROVAL_FORBIDDEN'
      using errcode = '42501';
  end if;

  if not public.attendance_explanation__internal_can_actor_decide(
    p_actor_app_user_id,
    v_row,
    v_today_local
  ) then
    raise exception 'ATTENDANCE_EXPLANATION_DECIDE_DENIED'
      using errcode = '42501';
  end if;

  if v_row.row_version <> p_expected_row_version then
    raise exception 'ATTENDANCE_EXPLANATION_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_row.status <> 'PENDING' then
    raise exception 'ATTENDANCE_EXPLANATION_ALREADY_DECIDED'
      using errcode = 'PT409';
  end if;

  v_next_status := case when v_decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end;

  update public.attendance_explanations
     set status = v_next_status,
         decided_at = clock_timestamp(),
         decided_by_app_user_id = p_actor_app_user_id,
         decision_note = v_note,
         row_version = v_row.row_version + 1,
         updated_at = clock_timestamp()
   where explanation_id = p_explanation_id
  returning * into v_row;

  insert into public.attendance_explanation_audit_events (
    explanation_id,
    action,
    actor_app_user_id,
    before_status,
    after_status,
    note,
    payload
  )
  values (
    v_row.explanation_id,
    v_next_status,
    p_actor_app_user_id,
    'PENDING',
    v_next_status,
    v_note,
    jsonb_build_object(
      'decision', v_decision,
      'business_date', v_row.business_date::text,
      'slot_code', v_row.slot_code
    )
  );

  v_response := jsonb_build_object(
    'replayed', false,
    'explanation', public.attendance_explanation__internal_project_item(v_row)
  );

  insert into public.attendance_explanation_idempotency_records (
    app_user_id,
    operation,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    p_actor_app_user_id,
    'explanation_decide',
    v_idempotency_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$$;

-- =============================================================================
-- SECTION 4: Monthly Attendance Matrix Report RPC with Explanation Integration
-- =============================================================================

create or replace function public.attendance_monthly_matrix_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_year_month text default null,
  p_branch_id uuid default null,
  p_employee_id uuid default null,
  p_search text default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_can_configure_hq boolean;
  v_today_vn date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_year_month text := coalesce(
    nullif(btrim(coalesce(p_year_month, '')), ''),
    to_char(v_today_vn, 'YYYY-MM')
  );
  v_year integer;
  v_month integer;
  v_month_start date;
  v_month_end date;
  v_days_in_month integer;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_escaped_search text := null;
  v_offset integer;
  v_current_hq jsonb := null;
  v_slot_policy jsonb := null;
  v_calendar_days jsonb := '[]'::jsonb;
  v_branch_options jsonb := '[]'::jsonb;
  v_employee_options jsonb := '[]'::jsonb;
  v_overview jsonb;
  v_items jsonb;
  v_total_rows integer := 0;
  v_total_pages integer := 0;
  v_snapshot_token text;
begin
  v_can_configure_hq := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  if v_year_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'ATTENDANCE_MATRIX_MONTH_INVALID'
      using errcode = '22023';
  end if;

  v_year := split_part(v_year_month, '-', 1)::integer;
  v_month := split_part(v_year_month, '-', 2)::integer;
  if v_year < 2000 or v_year > 2100 then
    raise exception 'ATTENDANCE_MATRIX_MONTH_INVALID'
      using errcode = '22023';
  end if;

  v_month_start := make_date(v_year, v_month, 1);
  v_month_end := (v_month_start + interval '1 month - 1 day')::date;
  v_days_in_month := (v_month_end - v_month_start) + 1;

  if v_page < 1 or v_page > 10000 or v_page_size < 1 or v_page_size > 100 then
    raise exception 'ATTENDANCE_REPORT_PAGINATION_INVALID'
      using errcode = '22023';
  end if;

  if v_search is not null and (
    length(v_search) > 100
    or v_search ~ '[\x00-\x1F\x7F]'
  ) then
    raise exception 'ATTENDANCE_REPORT_SEARCH_INVALID'
      using errcode = '22023';
  end if;

  if v_search is not null and p_employee_id is not null then
    raise exception 'ATTENDANCE_REPORT_FILTER_CONFLICT'
      using errcode = '22023';
  end if;

  if v_search is not null then
    v_escaped_search := replace(
      replace(
        replace(lower(v_search), '\', '\\'),
        '%', '\%'
      ),
      '_', '\_'
    );
  end if;

  v_offset := (v_page - 1) * v_page_size;

  -- Current HQ configuration
  select jsonb_build_object(
    'version', r.version,
    'latitude', r.latitude,
    'longitude', r.longitude,
    'effective_from', r.effective_from,
    'effective_from_local', to_char(
      r.effective_from at time zone 'Asia/Ho_Chi_Minh',
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'configured_by_display_name', u.display_name
  )
    into v_current_hq
  from public.attendance_hq_location_revisions r
  join public.direct_entry_app_users u
    on u.app_user_id = r.configured_by_user_id
  order by r.version desc
  limit 1;

  -- Slot policy summary
  with policy_with_bounds as (
    select
      p as policy_row,
      p.version,
      p.effective_from_date,
      (
        lead(p.effective_from_date) over (
          order by p.effective_from_date asc, p.version asc
        ) - 1
      ) as effective_to_date,
      u.display_name as actor_display_name
    from public.attendance_slot_policy_versions p
    left join public.direct_entry_app_users u
      on u.app_user_id = p.configured_by_user_id
  ),
  month_active_versions as (
    select distinct on (pb.version)
      pb.*
    from generate_series(v_month_start::timestamp, v_month_end::timestamp, interval '1 day') as cal(d)
    join lateral (
      select p2.*
      from policy_with_bounds p2
      where p2.effective_from_date <= cal.d::date
      order by p2.effective_from_date desc, p2.version desc
      limit 1
    ) pb on true
    order by pb.version asc
  )
  select jsonb_build_object(
    'current_policy', (
      select public.attendance__internal_format_slot_policy(
        pb.policy_row,
        pb.effective_to_date,
        pb.actor_display_name
      )
      from policy_with_bounds pb
      where pb.effective_from_date <= v_today_vn
      order by pb.effective_from_date desc, pb.version desc
      limit 1
    ),
    'latest_policy', (
      select public.attendance__internal_format_slot_policy(
        pb.policy_row,
        pb.effective_to_date,
        pb.actor_display_name
      )
      from policy_with_bounds pb
      order by pb.version desc
      limit 1
    ),
    'month_policies', coalesce(
      (
        select jsonb_agg(
          public.attendance__internal_format_slot_policy(
            mv.policy_row,
            mv.effective_to_date,
            mv.actor_display_name
          )
          order by mv.version asc
        )
        from month_active_versions mv
      ),
      '[]'::jsonb
    )
  )
    into v_slot_policy;

  -- Calendar days of the month
  select jsonb_agg(
    jsonb_build_object(
      'business_date', d::date,
      'day_of_month', extract(day from d)::integer,
      'day_of_week', extract(isodow from d)::integer
    )
    order by d::date asc
  )
    into v_calendar_days
  from generate_series(v_month_start::timestamp, v_month_end::timestamp, interval '1 day') as d;

  -- Branch filter options
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'branch_id', b.branch_id,
        'branch_code', b.branch_code,
        'display_name', b.display_name,
        'active', b.active,
        'latitude', b.latitude,
        'longitude', b.longitude,
        'version', b.version
      )
      order by b.branch_code asc, b.branch_id asc
    ),
    '[]'::jsonb
  )
    into v_branch_options
  from public.attendance_branches b;

  -- Employee options scoped to month
  with month_candidate_users as (
    select
      u.app_user_id,
      u.display_name,
      u.enabled,
      rec.personnel_code,
      br.branch_id,
      br.branch_code,
      br.display_name as branch_name
    from public.direct_entry_app_users u
    left join lateral (
      select r.personnel_code
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiters r
        on r.recruiter_id = l.recruiter_id
      where l.app_user_id = u.app_user_id
        and l.is_current = true
        and l.verified = true
      limit 1
    ) rec on true
    left join lateral (
      select
        b.branch_id,
        b.branch_code,
        b.display_name
      from public.attendance_branch_assignments a
      join public.attendance_branches b
        on b.branch_id = a.branch_id
      where a.app_user_id = u.app_user_id
        and a.valid_from <= v_month_end
        and (a.valid_to is null or a.valid_to >= v_month_start)
      order by a.valid_from desc
      limit 1
    ) br on true
    where u.enabled = true
       or exists (
         select 1
         from public.attendance_checkins c
         where c.app_user_id = u.app_user_id
           and c.business_date between v_month_start and v_month_end
       )
       or exists (
         select 1
         from public.leave_request_days ld
         join public.leave_requests lr
           on lr.request_id = ld.request_id
         where ld.app_user_id = u.app_user_id
           and lr.status = 'APPROVED'
           and ld.leave_date between v_month_start and v_month_end
       )
       or exists (
         select 1
         from public.attendance_explanations ae
         where ae.app_user_id = u.app_user_id
           and ae.business_date between v_month_start and v_month_end
       )
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'app_user_id', m.app_user_id,
        'display_name', m.display_name,
        'personnel_code', m.personnel_code,
        'branch_id', m.branch_id,
        'branch_code', m.branch_code,
        'branch_name', m.branch_name
      )
      order by lower(m.display_name) asc, m.app_user_id asc
    ),
    '[]'::jsonb
  )
    into v_employee_options
  from month_candidate_users m;

  -- Set-based monthly matrix calculation with flexible N-slot assignment, leave session coverage & explanations
  with month_day_policies as (
    select
      cal.d::date as business_date,
      extract(day from cal.d)::integer as day_of_month,
      pol.version as policy_version,
      pol.slots as policy_slots
    from generate_series(v_month_start::timestamp, v_month_end::timestamp, interval '1 day') as cal(d)
    join lateral (
      select p.*
      from public.attendance_slot_policy_versions p
      where p.effective_from_date <= cal.d::date
      order by p.effective_from_date desc, p.version desc
      limit 1
    ) pol on true
  ),
  month_day_slot_defs as (
    select
      mdp.business_date,
      mdp.day_of_month,
      mdp.policy_version,
      (slot_elem->>'slot_index')::integer as slot_index,
      slot_elem->>'slot_code' as slot_code,
      coalesce(
        nullif(btrim(coalesce(slot_elem->>'slot_label', '')), ''),
        'Time ' || (slot_elem->>'slot_index')
      ) as slot_label,
      slot_elem->>'session_code' as session_code,
      slot_elem->>'target_time' as target_time,
      (
        split_part(slot_elem->>'target_time', ':', 1)::integer * 60
        + split_part(slot_elem->>'target_time', ':', 2)::integer
      ) as target_minute,
      (slot_elem->>'grace_before_minutes')::integer as grace_before_minutes,
      (slot_elem->>'grace_after_minutes')::integer as grace_after_minutes
    from month_day_policies mdp
    cross join lateral jsonb_array_elements(mdp.policy_slots) as slot_elem
  ),
  candidate_employees as (
    select
      u.app_user_id,
      u.display_name as employee_display_name,
      u.enabled,
      rec.personnel_code,
      br.branch_id,
      br.branch_code,
      br.display_name as branch_display_name,
      br.address as branch_address,
      br.latitude as branch_latitude,
      br.longitude as branch_longitude,
      br.active as branch_active,
      br.version as branch_version,
      br.valid_from as branch_valid_from,
      br.valid_to as branch_valid_to
    from public.direct_entry_app_users u
    left join lateral (
      select r.personnel_code
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiters r
        on r.recruiter_id = l.recruiter_id
      where l.app_user_id = u.app_user_id
        and l.is_current = true
        and l.verified = true
      limit 1
    ) rec on true
    left join lateral (
      select
        b.branch_id,
        b.branch_code,
        b.display_name,
        b.address,
        b.latitude,
        b.longitude,
        b.active,
        b.version,
        a.valid_from,
        a.valid_to
      from public.attendance_branch_assignments a
      join public.attendance_branches b
        on b.branch_id = a.branch_id
      where a.app_user_id = u.app_user_id
        and a.valid_from <= v_month_end
        and (a.valid_to is null or a.valid_to >= v_month_start)
      order by a.valid_from desc
      limit 1
    ) br on true
    where (
      u.enabled = true
      or exists (
        select 1
        from public.attendance_checkins c
        where c.app_user_id = u.app_user_id
          and c.business_date between v_month_start and v_month_end
      )
      or exists (
        select 1
        from public.leave_request_days ld
        join public.leave_requests lr
          on lr.request_id = ld.request_id
        where ld.app_user_id = u.app_user_id
          and lr.status = 'APPROVED'
          and ld.leave_date between v_month_start and v_month_end
      )
      or exists (
        select 1
        from public.attendance_explanations ae
        where ae.app_user_id = u.app_user_id
          and ae.business_date between v_month_start and v_month_end
      )
    )
    and (p_employee_id is null or u.app_user_id = p_employee_id)
    and (
      p_branch_id is null
      or br.branch_id = p_branch_id
      or exists (
        select 1
        from public.attendance_checkins c
        where c.app_user_id = u.app_user_id
          and c.business_date between v_month_start and v_month_end
          and c.branch_id_used = p_branch_id
      )
    )
    and (
      v_escaped_search is null
      or lower(u.display_name) like '%' || v_escaped_search || '%' escape '\'
      or lower(coalesce(rec.personnel_code, '')) like '%' || v_escaped_search || '%' escape '\'
      or lower(coalesce(br.branch_code, '')) like '%' || v_escaped_search || '%' escape '\'
      or lower(coalesce(br.display_name, '')) like '%' || v_escaped_search || '%' escape '\'
    )
  ),
  month_checkins_raw as (
    select
      c.checkin_id,
      c.app_user_id,
      c.business_date,
      c.sequence_in_day,
      c.captured_at,
      to_char(c.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as captured_at_utc,
      to_char(c.captured_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') as captured_at_local,
      to_char(c.captured_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI') as time_local,
      (
        extract(hour from (c.captured_at at time zone 'Asia/Ho_Chi_Minh'))::integer * 60
        + extract(minute from (c.captured_at at time zone 'Asia/Ho_Chi_Minh'))::integer
      ) as local_minute_of_day,
      c.time_verified,
      case
        when c.distance_status is not null then coalesce(c.distance_target_kind, case when c.branch_id_used is not null then 'BRANCH' else 'HQ' end)
        else 'HQ'
      end as distance_target_kind,
      c.branch_id_used,
      c.branch_code_used,
      c.branch_name_used,
      case
        when c.distance_status is not null then c.branch_version_used
        else null
      end as branch_version_used,
      case
        when c.distance_status is not null then c.hq_version_used
        when c.accuracy_meters <= 100000.0 then hq.version
        else null
      end as hq_version_used,
      case
        when c.distance_status is not null then c.distance_status
        when c.accuracy_meters > 100000.0 then 'INVALID_GPS'
        when hq.version is null then 'HQ_NOT_CONFIGURED'
        else 'COMPUTED'
      end as distance_status,
      case
        when c.distance_status is not null then c.distance_meters
        when c.accuracy_meters > 100000.0 or hq.version is null then null
        else round(
          (
            2.0 * 6371000.0 * asin(
              least(
                1.0::double precision,
                sqrt(
                  greatest(
                    0.0::double precision,
                    power(sin(radians(c.latitude - hq.latitude) / 2.0), 2)
                    + cos(radians(hq.latitude))
                      * cos(radians(c.latitude))
                      * power(sin(radians(c.longitude - hq.longitude) / 2.0), 2)
                  )
                )
              )
            )
          )::numeric,
          1
        )::double precision
      end as distance_meters
    from public.attendance_checkins c
    join candidate_employees ce
      on ce.app_user_id = c.app_user_id
    left join lateral (
      select
        r.version,
        r.latitude,
        r.longitude
      from public.attendance_hq_location_revisions r
      where c.distance_status is null
        and r.effective_from <= (
          case
            when c.time_verified then c.captured_at
            else c.received_at
          end
        )
      order by r.effective_from desc, r.version desc
      limit 1
    ) hq on true
    where c.business_date between v_month_start and v_month_end
  ),
  month_checkins_enriched as (
    select
      mcr.*,
      ns.policy_version,
      ns.slot_index as assigned_slot_index,
      ns.slot_code as assigned_slot_code,
      ns.target_time as assigned_slot_target_time,
      (mcr.local_minute_of_day - ns.target_minute)::integer as delta_minutes,
      case
        when (mcr.local_minute_of_day - ns.target_minute) < (-ns.grace_before_minutes) then
          ((- (mcr.local_minute_of_day - ns.target_minute)) - ns.grace_before_minutes)::integer
        when (mcr.local_minute_of_day - ns.target_minute) > ns.grace_after_minutes then
          ((mcr.local_minute_of_day - ns.target_minute) - ns.grace_after_minutes)::integer
        else 0
      end as over_grace_minutes,
      case
        when (mcr.local_minute_of_day - ns.target_minute) < (-ns.grace_before_minutes) then 'EARLY'
        when (mcr.local_minute_of_day - ns.target_minute) > ns.grace_after_minutes then 'LATE'
        else 'ON_TIME'
      end as deviation_status
    from month_checkins_raw mcr
    cross join lateral (
      select
        s.policy_version,
        s.slot_index,
        s.slot_code,
        s.target_time,
        s.target_minute,
        s.grace_before_minutes,
        s.grace_after_minutes
      from month_day_slot_defs s
      where s.business_date = mcr.business_date
      -- Deterministic tie-break: when equidistant between two adjacent slots, choose earlier slot (slot_index asc)
      order by abs(mcr.local_minute_of_day - s.target_minute) asc, s.slot_index asc
      limit 1
    ) ns
  ),
  daily_slot_checkins as (
    select
      mc.app_user_id,
      mc.business_date,
      mc.assigned_slot_index as slot_index,
      count(*)::integer as checkin_count,
      count(*) filter (where mc.deviation_status <> 'ON_TIME')::integer as out_of_grace_count,
      jsonb_agg(
        jsonb_build_object(
          'checkin_id', mc.checkin_id,
          'sequence_in_day', mc.sequence_in_day,
          'captured_at', mc.captured_at_utc,
          'captured_at_local', mc.captured_at_local,
          'time_local', mc.time_local,
          'time_verified', mc.time_verified,
          'assigned_slot_code', mc.assigned_slot_code,
          'delta_minutes', mc.delta_minutes,
          'over_grace_minutes', mc.over_grace_minutes,
          'deviation_status', mc.deviation_status,
          'distance_target_kind', mc.distance_target_kind,
          'distance_status', mc.distance_status,
          'distance_meters', mc.distance_meters
        )
        order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc
      ) as checkins
    from month_checkins_enriched mc
    group by mc.app_user_id, mc.business_date, mc.assigned_slot_index
  ),
  daily_checkins as (
    select
      mc.app_user_id,
      mc.business_date,
      count(*)::integer as checkin_count,
      count(*) filter (where mc.time_verified)::integer as verified_checkin_count,
      count(*) filter (where not mc.time_verified)::integer as unverified_checkin_count,
      count(*) filter (where mc.deviation_status <> 'ON_TIME')::integer as late_or_early_checkin_count,
      count(*) filter (where mc.distance_status = 'COMPUTED')::integer as distance_computed_count,
      count(*) filter (where mc.distance_status <> 'COMPUTED')::integer as distance_unavailable_count,
      (array_agg(mc.checkin_id order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as first_checkin_id,
      (array_agg(mc.checkin_id order by mc.captured_at desc, mc.sequence_in_day desc, mc.checkin_id desc))[1] as last_checkin_id,
      min(mc.captured_at) as first_captured_at,
      max(mc.captured_at) as last_captured_at,
      (array_agg(mc.distance_target_kind order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as distance_target_kind,
      (array_agg(mc.branch_id_used order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as branch_id_used,
      (array_agg(mc.branch_code_used order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as branch_code_used,
      (array_agg(mc.branch_name_used order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as branch_name_used,
      (array_agg(mc.branch_version_used order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as branch_version_used,
      (array_agg(mc.hq_version_used order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as hq_version_used,
      (array_agg(mc.distance_status order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as distance_status,
      (array_agg(mc.distance_meters order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as distance_meters,
      min(mc.distance_meters) as min_distance_meters,
      max(mc.distance_meters) as max_distance_meters
    from month_checkins_enriched mc
    group by mc.app_user_id, mc.business_date
  ),
  daily_leaves as (
    select
      ld.app_user_id,
      ld.leave_date as business_date,
      sum(ld.half_day_units)::integer as half_day_units,
      round((sum(ld.half_day_units)::numeric / 2.0), 1)::double precision as leave_units,
      bool_or(ld.session_code in ('FULL', 'AM')) as am_covered,
      bool_or(ld.session_code in ('FULL', 'PM')) as pm_covered,
      jsonb_agg(
        jsonb_build_object(
          'request_id', ld.request_id,
          'leave_date', ld.leave_date,
          'session_code', ld.session_code,
          'leave_type', ld.leave_type,
          'half_day_units', ld.half_day_units
        )
        order by
          case ld.session_code
            when 'FULL' then 1
            when 'AM' then 2
            when 'PM' then 3
            else 4
          end asc,
          ld.leave_type asc,
          ld.request_id asc
      ) as approved_leaves
    from public.leave_request_days ld
    join public.leave_requests lr
      on lr.request_id = ld.request_id
    join candidate_employees ce
      on ce.app_user_id = ld.app_user_id
    where lr.status = 'APPROVED'
      and ld.is_active = true
      and ld.leave_date between v_month_start and v_month_end
    group by ld.app_user_id, ld.leave_date
  ),
  daily_slot_explanations as (
    select distinct on (ae.app_user_id, ae.business_date, ae.slot_code)
      ae.explanation_id,
      ae.app_user_id,
      ae.business_date,
      ae.slot_code,
      ae.slot_index,
      ae.original_slot_status,
      ae.reason,
      ae.status,
      ae.submitted_at,
      to_char(ae.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as submitted_at_utc,
      to_char(ae.submitted_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') as submitted_at_local,
      ae.decided_at,
      case
        when ae.decided_at is not null then
          to_char(ae.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        else null
      end as decided_at_utc,
      case
        when ae.decided_at is not null then
          to_char(ae.decided_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS')
        else null
      end as decided_at_local,
      du.display_name as decided_by_display_name,
      ae.decision_note,
      ae.row_version
    from public.attendance_explanations ae
    join candidate_employees ce
      on ce.app_user_id = ae.app_user_id
    left join public.direct_entry_app_users du
      on du.app_user_id = ae.decided_by_app_user_id
    where ae.business_date between v_month_start and v_month_end
    order by
      ae.app_user_id asc,
      ae.business_date asc,
      ae.slot_code asc,
      case ae.status
        when 'APPROVED' then 1
        when 'PENDING' then 2
        else 3
      end asc,
      ae.submitted_at desc,
      ae.explanation_id desc
  ),
  employee_rollup as (
    select
      ce.app_user_id,
      ce.employee_display_name,
      ce.personnel_code,
      ce.enabled,
      ce.branch_id,
      ce.branch_code,
      ce.branch_display_name,
      ce.branch_address,
      ce.branch_latitude,
      ce.branch_longitude,
      ce.branch_active,
      ce.branch_version,
      ce.branch_valid_from,
      ce.branch_valid_to,
      coalesce(chk.checkin_day_count, 0) as checkin_day_count,
      coalesce(chk.total_checkins, 0) as total_checkins,
      coalesce(chk.distance_computed_count, 0) as distance_computed_count,
      coalesce(chk.distance_unavailable_count, 0) as distance_unavailable_count,
      chk.min_distance_meters,
      chk.max_distance_meters,
      coalesce(lv.approved_leave_day_count, 0) as approved_leave_day_count,
      coalesce(lv.approved_leave_units, 0.0::double precision) as approved_leave_units,
      coalesce(both_days.overlap_day_count, 0) as checkin_and_leave_day_count,
      (v_days_in_month - coalesce(chk.checkin_day_count, 0))::integer as no_checkin_day_count,
      (
        v_days_in_month
        - coalesce(chk.checkin_day_count, 0)
        - (coalesce(lv.approved_leave_day_count, 0) - coalesce(both_days.overlap_day_count, 0))
      )::integer as no_checkin_without_leave_day_count
    from candidate_employees ce
    left join lateral (
      select
        count(*)::integer as checkin_day_count,
        coalesce(sum(dc.checkin_count), 0)::integer as total_checkins,
        coalesce(sum(dc.distance_computed_count), 0)::integer as distance_computed_count,
        coalesce(sum(dc.distance_unavailable_count), 0)::integer as distance_unavailable_count,
        min(dc.min_distance_meters) as min_distance_meters,
        max(dc.max_distance_meters) as max_distance_meters
      from daily_checkins dc
      where dc.app_user_id = ce.app_user_id
    ) chk on true
    left join lateral (
      select
        count(*)::integer as approved_leave_day_count,
        coalesce(round((sum(dl.half_day_units)::numeric / 2.0), 1)::double precision, 0.0::double precision) as approved_leave_units
      from daily_leaves dl
      where dl.app_user_id = ce.app_user_id
    ) lv on true
    left join lateral (
      select count(*)::integer as overlap_day_count
      from daily_checkins dc
      join daily_leaves dl
        on dl.app_user_id = dc.app_user_id
       and dl.business_date = dc.business_date
      where dc.app_user_id = ce.app_user_id
    ) both_days on true
  ),
  agg as (
    select
      count(*)::integer as total_employees,
      count(*) filter (where er.checkin_day_count > 0)::integer as employees_with_checkins,
      count(*) filter (where er.approved_leave_day_count > 0)::integer as employees_with_approved_leave,
      coalesce(sum(er.total_checkins), 0)::integer as total_checkins,
      coalesce(sum(er.checkin_day_count), 0)::integer as total_checkin_days,
      coalesce(sum(er.approved_leave_day_count), 0)::integer as total_approved_leave_days,
      coalesce(round(sum(er.approved_leave_units)::numeric, 1)::double precision, 0.0::double precision) as total_approved_leave_units,
      coalesce(sum(er.no_checkin_day_count), 0)::integer as total_no_checkin_days,
      coalesce(sum(er.no_checkin_without_leave_day_count), 0)::integer as total_no_checkin_without_leave_days,
      pg_catalog.md5(
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'u', er2.app_user_id,
                'n', er2.employee_display_name,
                'p', er2.personnel_code,
                'e', er2.enabled,
                'b', er2.branch_id,
                'bc', er2.branch_code,
                'bn', er2.branch_display_name,
                'ba', er2.branch_address,
                'blat', er2.branch_latitude,
                'blon', er2.branch_longitude,
                'bact', er2.branch_active,
                'bv', er2.branch_version,
                'bf', er2.branch_valid_from,
                'bt', er2.branch_valid_to,
                'cd', er2.checkin_day_count,
                'tc', er2.total_checkins,
                'dc', er2.distance_computed_count,
                'du', er2.distance_unavailable_count,
                'dmin', er2.min_distance_meters,
                'dmax', er2.max_distance_meters,
                'ld', er2.approved_leave_day_count,
                'lu', er2.approved_leave_units,
                'ov', er2.checkin_and_leave_day_count
              )
              order by
                lower(er2.employee_display_name) asc,
                coalesce(er2.personnel_code, '') asc,
                er2.app_user_id asc
            )::text
            from employee_rollup er2
          ),
          '[]'
        )
        || '|' ||
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'id', mc2.checkin_id,
                'u', mc2.app_user_id,
                'd', mc2.business_date,
                'seq', mc2.sequence_in_day,
                't', mc2.captured_at_utc,
                'v', mc2.time_verified,
                's', mc2.assigned_slot_code,
                'dm', mc2.delta_minutes,
                'og', mc2.over_grace_minutes,
                'dv', mc2.deviation_status,
                'k', mc2.distance_target_kind,
                'bi', mc2.branch_id_used,
                'bv', mc2.branch_version_used,
                'hv', mc2.hq_version_used,
                'ds', mc2.distance_status,
                'dist', mc2.distance_meters
              )
              order by mc2.app_user_id asc, mc2.business_date asc, mc2.captured_at asc, mc2.sequence_in_day asc, mc2.checkin_id asc
            )::text
            from month_checkins_enriched mc2
          ),
          '[]'
        )
        || '|' ||
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'u', dl2.app_user_id,
                'd', dl2.business_date,
                'h', dl2.half_day_units,
                'l', dl2.approved_leaves
              )
              order by dl2.app_user_id asc, dl2.business_date asc
            )::text
            from daily_leaves dl2
          ),
          '[]'
        )
        || '|' ||
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'd', mdp2.business_date,
                'pv', mdp2.policy_version,
                'sl', mdp2.policy_slots
              )
              order by mdp2.business_date asc
            )::text
            from month_day_policies mdp2
          ),
          '[]'
        )
        || '|' ||
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'id', dse2.explanation_id,
                'u', dse2.app_user_id,
                'd', dse2.business_date,
                'sc', dse2.slot_code,
                'st', dse2.status,
                'rv', dse2.row_version
              )
              order by dse2.app_user_id asc, dse2.business_date asc, dse2.slot_code asc
            )::text
            from daily_slot_explanations dse2
          ),
          '[]'
        )
      ) as snapshot_token
    from employee_rollup er
  ),
  paged_employees as (
    select er.*
    from employee_rollup er
    order by
      lower(er.employee_display_name) asc,
      coalesce(er.personnel_code, '') asc,
      er.app_user_id asc
    limit v_page_size
    offset v_offset
  ),
  paged_with_days as (
    select
      pe.*,
      (
        select jsonb_agg(
          jsonb_build_object(
            'business_date', mdp.business_date,
            'day_of_month', mdp.day_of_month,
            'policy_version_used', mdp.policy_version,
            'has_checkin', (dc.checkin_count is not null and dc.checkin_count > 0),
            'checkin_count', coalesce(dc.checkin_count, 0),
            'first_checkin_id', dc.first_checkin_id,
            'last_checkin_id', dc.last_checkin_id,
            'first_captured_at', dc.first_captured_at,
            'first_captured_at_local', case
              when dc.first_captured_at is not null then
                to_char(dc.first_captured_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS')
              else null
            end,
            'first_time_local', case
              when dc.first_captured_at is not null then
                to_char(dc.first_captured_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI')
              else null
            end,
            'last_captured_at', dc.last_captured_at,
            'last_captured_at_local', case
              when dc.last_captured_at is not null then
                to_char(dc.last_captured_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS')
              else null
            end,
            'last_time_local', case
              when dc.last_captured_at is not null then
                to_char(dc.last_captured_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI')
              else null
            end,
            'verified_checkin_count', coalesce(dc.verified_checkin_count, 0),
            'unverified_checkin_count', coalesce(dc.unverified_checkin_count, 0),
            'distance_target_kind', dc.distance_target_kind,
            'branch_id_used', dc.branch_id_used,
            'branch_code_used', dc.branch_code_used,
            'branch_name_used', dc.branch_name_used,
            'branch_version_used', dc.branch_version_used,
            'hq_version_used', dc.hq_version_used,
            'distance_status', dc.distance_status,
            'distance_meters', dc.distance_meters,
            'min_distance_meters', dc.min_distance_meters,
            'max_distance_meters', dc.max_distance_meters,
            'has_approved_leave', (dl.leave_units is not null and dl.leave_units > 0),
            'approved_leave_units', coalesce(dl.leave_units, 0.0::double precision),
            'approved_leaves', coalesce(dl.approved_leaves, '[]'::jsonb),
            'day_status', case
              when dc.checkin_count is not null and dc.checkin_count > 0
                   and dl.leave_units is not null and dl.leave_units > 0 then 'CHECKED_IN_AND_LEAVE'
              when dc.checkin_count is not null and dc.checkin_count > 0 then 'CHECKED_IN'
              when dl.leave_units is not null and dl.leave_units > 0 then 'APPROVED_LEAVE'
              else 'NO_CHECKIN'
            end,
            'missing_slot_count', day_slots.missing_slot_count,
            'late_or_early_checkin_count', day_slots.late_or_early_checkin_count,
            'slots', day_slots.slots
          )
          order by mdp.business_date asc
        )
        from month_day_policies mdp
        left join daily_checkins dc
          on dc.app_user_id = pe.app_user_id
         and dc.business_date = mdp.business_date
        left join daily_leaves dl
          on dl.app_user_id = pe.app_user_id
         and dl.business_date = mdp.business_date
        cross join lateral (
          select
            count(*) filter (
              where coalesce(dsc.checkin_count, 0) = 0
                and not (
                  case
                    when mds.session_code = 'AM' then coalesce(dl.am_covered, false)
                    else coalesce(dl.pm_covered, false)
                  end
                )
                and coalesce(dse.status, '') <> 'APPROVED'
            )::integer as missing_slot_count,
            coalesce(
              sum(dsc.out_of_grace_count) filter (
                where coalesce(dse.status, '') <> 'APPROVED'
              ),
              0
            )::integer as late_or_early_checkin_count,
            coalesce(
              jsonb_agg(
                jsonb_build_object(
                  'slot_code', mds.slot_code,
                  'slot_index', mds.slot_index,
                  'slot_label', mds.slot_label,
                  'session_code', mds.session_code,
                  'target_time', mds.target_time,
                  'grace_before_minutes', mds.grace_before_minutes,
                  'grace_after_minutes', mds.grace_after_minutes,
                  'is_leave_covered', case
                    when mds.session_code = 'AM' then coalesce(dl.am_covered, false)
                    else coalesce(dl.pm_covered, false)
                  end,
                  'slot_status', case
                    when dse.status = 'APPROVED' and (
                      (coalesce(dsc.checkin_count, 0) > 0 and coalesce(dsc.out_of_grace_count, 0) > 0)
                      or (
                        coalesce(dsc.checkin_count, 0) = 0
                        and not (
                          case
                            when mds.session_code = 'AM' then coalesce(dl.am_covered, false)
                            else coalesce(dl.pm_covered, false)
                          end
                        )
                      )
                    ) then 'EXPLAINED_APPROVED'
                    when coalesce(dsc.checkin_count, 0) > 0 and coalesce(dsc.out_of_grace_count, 0) > 0 then 'OUT_OF_GRACE'
                    when coalesce(dsc.checkin_count, 0) > 0 then 'ON_TIME'
                    when (
                      case
                        when mds.session_code = 'AM' then coalesce(dl.am_covered, false)
                        else coalesce(dl.pm_covered, false)
                      end
                    ) then 'LEAVE_COVERED'
                    else 'MISSING'
                  end,
                  'checkins', coalesce(dsc.checkins, '[]'::jsonb),
                  'explanation', case
                    when dse.explanation_id is not null then
                      jsonb_build_object(
                        'explanation_id', dse.explanation_id,
                        'status', dse.status,
                        'original_slot_status', dse.original_slot_status,
                        'reason', dse.reason,
                        'submitted_at', dse.submitted_at_utc,
                        'submitted_at_local', dse.submitted_at_local,
                        'decided_at', dse.decided_at_utc,
                        'decided_at_local', dse.decided_at_local,
                        'decided_by_display_name', dse.decided_by_display_name,
                        'decision_note', dse.decision_note,
                        'row_version', dse.row_version
                      )
                    else null
                  end
                )
                order by mds.slot_index asc
              ),
              '[]'::jsonb
            ) as slots
          from month_day_slot_defs mds
          left join daily_slot_checkins dsc
            on dsc.app_user_id = pe.app_user_id
           and dsc.business_date = mdp.business_date
           and dsc.slot_index = mds.slot_index
          left join daily_slot_explanations dse
            on dse.app_user_id = pe.app_user_id
           and dse.business_date = mdp.business_date
           and dse.slot_code = mds.slot_code
          where mds.business_date = mdp.business_date
        ) day_slots
      ) as days
    from paged_employees pe
  )
  select
    a.total_employees,
    a.snapshot_token,
    jsonb_build_object(
      'total_employees', a.total_employees,
      'employees_with_checkins', a.employees_with_checkins,
      'employees_with_approved_leave', a.employees_with_approved_leave,
      'total_checkins', a.total_checkins,
      'total_checkin_days', a.total_checkin_days,
      'total_approved_leave_days', a.total_approved_leave_days,
      'total_approved_leave_units', a.total_approved_leave_units,
      'total_no_checkin_days', a.total_no_checkin_days,
      'total_no_checkin_without_leave_days', a.total_no_checkin_without_leave_days
    ),
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'app_user_id', pwd.app_user_id,
            'employee_display_name', pwd.employee_display_name,
            'personnel_code', pwd.personnel_code,
            'enabled', pwd.enabled,
            'branch', case
              when pwd.branch_id is not null then
                jsonb_build_object(
                  'branch_id', pwd.branch_id,
                  'branch_code', pwd.branch_code,
                  'display_name', pwd.branch_display_name,
                  'address', pwd.branch_address,
                  'latitude', pwd.branch_latitude,
                  'longitude', pwd.branch_longitude,
                  'active', pwd.branch_active,
                  'version', pwd.branch_version,
                  'valid_from', pwd.branch_valid_from,
                  'valid_to', pwd.branch_valid_to
                )
              else null
            end,
            'summary', jsonb_build_object(
              'checkin_day_count', pwd.checkin_day_count,
              'total_checkins', pwd.total_checkins,
              'approved_leave_day_count', pwd.approved_leave_day_count,
              'approved_leave_units', pwd.approved_leave_units,
              'checkin_and_leave_day_count', pwd.checkin_and_leave_day_count,
              'no_checkin_day_count', pwd.no_checkin_day_count,
              'no_checkin_without_leave_day_count', pwd.no_checkin_without_leave_day_count,
              'distance_computed_count', pwd.distance_computed_count,
              'distance_unavailable_count', pwd.distance_unavailable_count,
              'min_distance_meters', pwd.min_distance_meters,
              'max_distance_meters', pwd.max_distance_meters
            ),
            'days', pwd.days
          )
          order by
            lower(pwd.employee_display_name) asc,
            coalesce(pwd.personnel_code, '') asc,
            pwd.app_user_id asc
        )
        from paged_with_days pwd
      ),
      '[]'::jsonb
    )
  into v_total_rows, v_snapshot_token, v_overview, v_items
  from agg a;

  v_total_pages := case
    when v_total_rows = 0 then 0
    else ceil(v_total_rows::numeric / v_page_size::numeric)::integer
  end;

  return jsonb_build_object(
    'viewer', jsonb_build_object(
      'can_configure_hq', v_can_configure_hq,
      'can_manage_branches', v_can_configure_hq,
      'can_manage_slot_policy', v_can_configure_hq
    ),
    'filters', jsonb_build_object(
      'year_month', v_year_month,
      'from_date', v_month_start,
      'to_date', v_month_end,
      'branch_id', p_branch_id,
      'employee_id', p_employee_id,
      'search', v_search,
      'timezone', 'Asia/Ho_Chi_Minh'
    ),
    'days_in_month', v_days_in_month,
    'calendar_days', v_calendar_days,
    'current_hq', v_current_hq,
    'slot_policy', v_slot_policy,
    'branch_options', v_branch_options,
    'employee_options', v_employee_options,
    'overview', v_overview,
    'pagination', jsonb_build_object(
      'page', v_page,
      'page_size', v_page_size,
      'total_rows', v_total_rows,
      'total_pages', v_total_pages,
      'has_more', (v_page < v_total_pages),
      'snapshot_token', v_snapshot_token
    ),
    'items', v_items
  );
end;
$$;

-- =============================================================================
-- SECTION 5: Owner Alignment, Strict ACLs & Helper Grants
-- =============================================================================

do $owner_align$
declare
  v_base_owner_oid oid;
  v_owner name;
  v_fn regprocedure;
  v_proc_owner_oid oid;
  v_tbl regclass;
  v_tbl_owner_oid oid;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_owner
  from pg_catalog.pg_class c
  join pg_catalog.pg_roles r on r.oid = c.relowner
  where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_owner is null then
    raise exception 'ATTENDANCE_EXPLANATIONS_OWNER_RESOLUTION_FAILED';
  end if;

  for v_tbl, v_tbl_owner_oid in
    select c.oid::regclass, c.relowner
      from pg_catalog.pg_class c
     where c.oid in (
       'public.attendance_explanations'::pg_catalog.regclass,
       'public.attendance_explanation_audit_events'::pg_catalog.regclass,
       'public.attendance_explanation_idempotency_records'::pg_catalog.regclass
     )
  loop
    if v_tbl_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter table %s owner to %I', v_tbl, v_owner);
    end if;
  end loop;

  for v_fn, v_proc_owner_oid in
    select p.oid::regprocedure, p.proowner
      from pg_catalog.pg_proc p
     where p.oid in (
       'public.attendance_explanation__internal_can_actor_decide(uuid,public.attendance_explanations,date)'::pg_catalog.regprocedure,
       'public.attendance_explanation__internal_evaluate_employee_day_slots(uuid,date)'::pg_catalog.regprocedure,
       'public.attendance_explanation__internal_project_item(public.attendance_explanations)'::pg_catalog.regprocedure,
       'public.attendance_get_my_explanations_overview(uuid,uuid,date,integer,integer)'::pg_catalog.regprocedure,
       'public.attendance_submit_explanation(uuid,uuid,date,text,text,text,text)'::pg_catalog.regprocedure,
       'public.attendance_list_explanation_approval_inbox(uuid,uuid,text,integer,integer)'::pg_catalog.regprocedure,
       'public.attendance_decide_explanation(uuid,uuid,uuid,text,integer,text,text,text)'::pg_catalog.regprocedure,
       'public.attendance_monthly_matrix_report(uuid,uuid,text,uuid,uuid,text,integer,integer)'::pg_catalog.regprocedure
     )
  loop
    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_owner);
    end if;
  end loop;
end;
$owner_align$;

revoke all on function public.attendance_explanation__internal_can_actor_decide(
  uuid,
  public.attendance_explanations,
  date
)
  from public, anon, authenticated, service_role;

revoke all on function public.attendance_explanation__internal_evaluate_employee_day_slots(
  uuid,
  date
)
  from public, anon, authenticated, service_role;

revoke all on function public.attendance_explanation__internal_project_item(
  public.attendance_explanations
)
  from public, anon, authenticated, service_role;

revoke all on function public.attendance_get_my_explanations_overview(
  uuid,
  uuid,
  date,
  integer,
  integer
)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_get_my_explanations_overview(
  uuid,
  uuid,
  date,
  integer,
  integer
)
  to service_role;

revoke all on function public.attendance_submit_explanation(
  uuid,
  uuid,
  date,
  text,
  text,
  text,
  text
)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_submit_explanation(
  uuid,
  uuid,
  date,
  text,
  text,
  text,
  text
)
  to service_role;

revoke all on function public.attendance_list_explanation_approval_inbox(
  uuid,
  uuid,
  text,
  integer,
  integer
)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_list_explanation_approval_inbox(
  uuid,
  uuid,
  text,
  integer,
  integer
)
  to service_role;

revoke all on function public.attendance_decide_explanation(
  uuid,
  uuid,
  uuid,
  text,
  integer,
  text,
  text,
  text
)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_decide_explanation(
  uuid,
  uuid,
  uuid,
  text,
  integer,
  text,
  text,
  text
)
  to service_role;

revoke all on function public.attendance_monthly_matrix_report(
  uuid,
  uuid,
  text,
  uuid,
  uuid,
  text,
  integer,
  integer
)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_monthly_matrix_report(
  uuid,
  uuid,
  text,
  uuid,
  uuid,
  text,
  integer,
  integer
)
  to service_role;

do $grant_internal_owner_exec$
declare
  v_base_owner name;
  v_owner name;
  v_helper_fn pg_catalog.regprocedure;
begin
  select r.rolname
    into v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  execute pg_catalog.format(
    'grant select, insert, update on table public.attendance_explanations to %I',
    v_base_owner
  );
  execute pg_catalog.format(
    'grant select, insert on table public.attendance_explanation_audit_events to %I',
    v_base_owner
  );
  execute pg_catalog.format(
    'grant select, insert on table public.attendance_explanation_idempotency_records to %I',
    v_base_owner
  );

  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid in (
       'public.attendance_explanation__internal_can_actor_decide(uuid,public.attendance_explanations,date)'::pg_catalog.regprocedure,
       'public.attendance_explanation__internal_evaluate_employee_day_slots(uuid,date)'::pg_catalog.regprocedure,
       'public.attendance_explanation__internal_project_item(public.attendance_explanations)'::pg_catalog.regprocedure,
       'public.attendance_get_my_explanations_overview(uuid,uuid,date,integer,integer)'::pg_catalog.regprocedure,
       'public.attendance_submit_explanation(uuid,uuid,date,text,text,text,text)'::pg_catalog.regprocedure,
       'public.attendance_list_explanation_approval_inbox(uuid,uuid,text,integer,integer)'::pg_catalog.regprocedure,
       'public.attendance_decide_explanation(uuid,uuid,uuid,text,integer,text,text,text)'::pg_catalog.regprocedure,
       'public.attendance_monthly_matrix_report(uuid,uuid,text,uuid,uuid,text,integer,integer)'::pg_catalog.regprocedure
     )
  loop
    for v_helper_fn in
      select p.oid::pg_catalog.regprocedure
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in (
           'leave_management__internal_immutable_guard',
           'leave_management__internal_resolve_authority',
           'leave_management__internal_resolve_routing',
           'leave_management__internal_can_actor_decide_request',
           'leave_management__internal_account_summary',
           'attendance__internal_immutable_guard',
           'attendance__internal_assert_report_reader',
           'attendance__internal_validate_slots_jsonb',
           'attendance__internal_normalize_slots_jsonb',
           'attendance__internal_format_slot_policy',
           'attendance_explanation__internal_can_actor_decide',
           'attendance_explanation__internal_evaluate_employee_day_slots',
           'attendance_explanation__internal_project_item',
           'direct_entry_assert_actor_mapping',
           'direct_entry_assert_actor_app_user_admin',
           'direct_entry_has_capability',
           'direct_entry_has_scope',
           'direct_entry_authorization_date'
         )
    loop
      execute pg_catalog.format(
        'grant execute on function %s to %I',
        v_helper_fn,
        v_owner
      );
    end loop;
  end loop;
end;
$grant_internal_owner_exec$;

commit;
