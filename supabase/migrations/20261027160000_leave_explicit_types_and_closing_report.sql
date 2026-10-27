-- Leave Management: explicit leave types (ANNUAL, BEREAVEMENT, MARRIAGE, SICK, UNPAID),
-- per-request type limits, multi-type allocation within a single request, FIFO deduction
-- strictly for ANNUAL leave, optional admin/request reasons preserved, and monthly
-- attendance + leave closing report without salary/pay-treatment inference.

begin;

-- =====================================================================
-- 1. SCHEMA UPDATES FOR EXPLICIT LEAVE TYPES & MULTI-TYPE ALLOCATION
-- =====================================================================

alter table public.leave_requests
  drop constraint if exists leave_requests_pay_treatment_chk;

alter table public.leave_requests
  alter column pay_treatment drop not null,
  alter column pay_treatment set default null;

alter table public.leave_request_days
  add column if not exists leave_type text;

update public.leave_request_days d
   set leave_type = case
     when r.pay_treatment = 'PAID_LEAVE' then 'ANNUAL'
     when r.pay_treatment in ('UNPAID_PROBATION', 'UNPAID_UNCONFIGURED_PROFILE') then 'UNPAID'
     else 'ANNUAL'
   end
  from public.leave_requests r
 where r.request_id = d.request_id
   and d.leave_type is null;

update public.leave_request_days
   set leave_type = 'ANNUAL'
 where leave_type is null;

alter table public.leave_request_days
  alter column leave_type set default 'ANNUAL',
  alter column leave_type set not null;

alter table public.leave_request_days
  drop constraint if exists leave_request_days_leave_type_chk;

alter table public.leave_request_days
  add constraint leave_request_days_leave_type_chk
  check (leave_type in ('ANNUAL', 'BEREAVEMENT', 'MARRIAGE', 'SICK', 'UNPAID'));

alter table public.leave_request_days
  drop constraint if exists leave_request_days_request_date_uidx;

alter table public.leave_request_days
  drop constraint if exists leave_request_days_request_date_session_uidx;

alter table public.leave_request_days
  add constraint leave_request_days_request_date_session_uidx
  unique (request_id, leave_date, session_code);

create index if not exists leave_request_days_user_type_date_idx
  on public.leave_request_days (app_user_id, leave_type, leave_date);

-- =====================================================================
-- 2. INTERNAL BALANCE & PROJECTION HELPERS (NO PAY_TREATMENT INFERENCE)
-- =====================================================================

create or replace function public.leave_management__internal_compute_balance_summary(
  p_app_user_id uuid,
  p_leave_year integer,
  p_as_of date default public.leave_management__internal_business_date()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_profile public.leave_employee_profiles%rowtype;
  v_has_profile boolean := false;
  v_profile_configured boolean := false;
  v_total_granted integer := 0;
  v_carry_over_granted integer := 0;
  v_monthly_accrued integer := 0;
  v_seniority_granted integer := 0;
  v_opening_current_year integer := 0;
  v_reserved integer := 0;
  v_consumed integer := 0;
  v_expired integer := 0;
  v_available integer := 0;
  v_carry_over_available integer := 0;
  v_pending_annual integer := 0;
  v_pending_non_annual integer := 0;
  v_pending_unpaid integer := 0;
  v_approved_annual integer := 0;
  v_approved_non_annual integer := 0;
  v_approved_bereavement integer := 0;
  v_approved_marriage integer := 0;
  v_approved_sick integer := 0;
  v_approved_unpaid integer := 0;
  v_lots jsonb := '[]'::jsonb;
begin
  select p.*
    into v_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_app_user_id;

  if found then
    v_has_profile := true;
    v_profile_configured := (
      not v_profile.is_shared_non_employee
      and v_profile.employment_status in ('PROBATION', 'OFFICIAL')
      and v_profile.work_start_date is not null
      and (
        v_profile.employment_status <> 'OFFICIAL'
        or v_profile.official_effective_date is not null
      )
    );
  end if;

  select coalesce(sum(l.granted_units), 0)::integer,
         coalesce(sum(l.granted_units) filter (where l.lot_kind = 'CARRY_OVER'), 0)::integer,
         coalesce(sum(l.granted_units) filter (where l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP')), 0)::integer,
         coalesce(sum(l.granted_units) filter (where l.lot_kind = 'SENIORITY_GRANT'), 0)::integer,
         coalesce(sum(l.granted_units) filter (where l.lot_kind in ('OPENING_CURRENT_YEAR', 'MANUAL_ADJUSTMENT')), 0)::integer,
         coalesce(sum(l.reserved_units), 0)::integer,
         coalesce(sum(l.consumed_units), 0)::integer,
         coalesce(sum(l.expired_units), 0)::integer,
         coalesce(
           sum(l.granted_units - l.reserved_units - l.consumed_units - l.expired_units)
             filter (
               where l.usable_from_date <= p_as_of
                 and (l.expires_after_date is null or p_as_of <= l.expires_after_date)
             ),
           0
         )::integer,
         coalesce(
           sum(l.granted_units - l.reserved_units - l.consumed_units - l.expired_units)
             filter (
               where l.lot_kind = 'CARRY_OVER'
                 and l.usable_from_date <= p_as_of
                 and (l.expires_after_date is null or p_as_of <= l.expires_after_date)
             ),
           0
         )::integer,
         coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'lot_id', l.lot_id,
               'leave_year', l.leave_year,
               'lot_kind', l.lot_kind,
               'accrual_month', l.accrual_month,
               'granted_units', l.granted_units,
               'reserved_units', l.reserved_units,
               'consumed_units', l.consumed_units,
               'expired_units', l.expired_units,
               'available_units', (l.granted_units - l.reserved_units - l.consumed_units - l.expired_units),
               'usable_from_date', l.usable_from_date,
               'expires_after_date', l.expires_after_date,
               'source_ref', l.source_ref
             )
             order by l.expires_after_date asc nulls last, l.usable_from_date asc, l.created_at asc, l.lot_id asc
           ),
           '[]'::jsonb
         )
    into v_total_granted,
         v_carry_over_granted,
         v_monthly_accrued,
         v_seniority_granted,
         v_opening_current_year,
         v_reserved,
         v_consumed,
         v_expired,
         v_available,
         v_carry_over_available,
         v_lots
    from public.leave_lots l
   where l.app_user_id = p_app_user_id
     and l.leave_year = p_leave_year;

  select coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'PENDING' and d.leave_type = 'ANNUAL'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'PENDING' and d.leave_type <> 'ANNUAL'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'PENDING' and d.leave_type = 'UNPAID'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type = 'ANNUAL'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type <> 'ANNUAL'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type = 'BEREAVEMENT'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type = 'MARRIAGE'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type = 'SICK'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type = 'UNPAID'),
           0
         )::integer
    into v_pending_annual,
         v_pending_non_annual,
         v_pending_unpaid,
         v_approved_annual,
         v_approved_non_annual,
         v_approved_bereavement,
         v_approved_marriage,
         v_approved_sick,
         v_approved_unpaid
    from public.leave_requests r
    join public.leave_request_days d on d.request_id = r.request_id
   where r.app_user_id = p_app_user_id
     and pg_catalog.date_part('year', d.leave_date)::integer = p_leave_year;

  return pg_catalog.jsonb_build_object(
    'leave_year', p_leave_year,
    'as_of_date', p_as_of,
    'has_profile', v_has_profile,
    'profile_configured', v_profile_configured,
    'employment_status', case when v_has_profile then v_profile.employment_status else 'UNCONFIGURED' end,
    'unit_kind', case when v_has_profile then v_profile.unit_kind else 'UNCLASSIFIED' end,
    'work_start_date', case when v_has_profile then v_profile.work_start_date else null end,
    'official_effective_date', case when v_has_profile then v_profile.official_effective_date else null end,
    'next_seniority_effective_date', case when v_has_profile then v_profile.next_seniority_effective_date else null end,
    'next_seniority_units', case when v_has_profile then v_profile.next_seniority_units else 0 end,
    'total_granted_units', v_total_granted,
    'carry_over_granted_units', v_carry_over_granted,
    'carry_over_available_units', v_carry_over_available,
    'monthly_accrued_units', v_monthly_accrued,
    'seniority_granted_units', v_seniority_granted,
    'opening_or_adjustment_units', v_opening_current_year,
    'available_units', v_available,
    'reserved_units', v_reserved,
    'consumed_units', v_consumed,
    'expired_units', v_expired,
    'pending_annual_units', v_pending_annual,
    'pending_non_annual_units', v_pending_non_annual,
    'pending_unpaid_units', v_pending_unpaid,
    'approved_annual_units', v_approved_annual,
    'approved_non_annual_units', v_approved_non_annual,
    'approved_bereavement_units', v_approved_bereavement,
    'approved_marriage_units', v_approved_marriage,
    'approved_sick_units', v_approved_sick,
    'approved_unpaid_units', v_approved_unpaid,
    'lots', v_lots
  );
end;
$function$;

create or replace function public.leave_management__internal_project_request(
  p_request public.leave_requests
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_days jsonb := '[]'::jsonb;
  v_leave_types jsonb := '[]'::jsonb;
  v_type_breakdown jsonb := '[]'::jsonb;
  v_requested_annual_units integer := 0;
  v_requested_non_annual_units integer := 0;
  v_allocations jsonb := '[]'::jsonb;
  v_requester jsonb;
  v_primary_approver jsonb;
  v_decided_by jsonb;
begin
  v_requester := public.leave_management__internal_account_summary(p_request.app_user_id);
  if p_request.primary_approver_app_user_id is not null then
    v_primary_approver := public.leave_management__internal_account_summary(p_request.primary_approver_app_user_id);
  end if;
  if p_request.decided_by_app_user_id is not null then
    v_decided_by := public.leave_management__internal_account_summary(p_request.decided_by_app_user_id);
  end if;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'request_day_id', d.request_day_id,
               'leave_date', d.leave_date,
               'session_code', d.session_code,
               'leave_type', d.leave_type,
               'half_day_units', d.half_day_units,
               'is_active', d.is_active
             )
             order by d.leave_date asc,
                      case d.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                      d.request_day_id asc
           ),
           '[]'::jsonb
         )
    into v_days
    from public.leave_request_days d
   where d.request_id = p_request.request_id;

  select coalesce(
           pg_catalog.jsonb_agg(t.leave_type order by t.first_date asc, t.type_order asc),
           '[]'::jsonb
         ),
         coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'leave_type', t.leave_type,
               'half_day_units', t.half_day_units
             )
             order by t.first_date asc, t.type_order asc
           ),
           '[]'::jsonb
         ),
         coalesce(sum(t.half_day_units) filter (where t.leave_type = 'ANNUAL'), 0)::integer,
         coalesce(sum(t.half_day_units) filter (where t.leave_type <> 'ANNUAL'), 0)::integer
    into v_leave_types,
         v_type_breakdown,
         v_requested_annual_units,
         v_requested_non_annual_units
    from (
      select d.leave_type,
             sum(d.half_day_units)::integer as half_day_units,
             min(d.leave_date) as first_date,
             case d.leave_type
               when 'ANNUAL' then 1
               when 'BEREAVEMENT' then 2
               when 'MARRIAGE' then 3
               when 'SICK' then 4
               when 'UNPAID' then 5
               else 9
             end as type_order
        from public.leave_request_days d
       where d.request_id = p_request.request_id
       group by d.leave_type
    ) t;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'allocation_id', a.allocation_id,
               'request_day_id', a.request_day_id,
               'lot_id', a.lot_id,
               'lot_kind', l.lot_kind,
               'leave_date', a.leave_date,
               'allocated_units', a.allocated_units,
               'status', a.status,
               'settled_at', a.settled_at,
               'released_at', a.released_at
             )
             order by a.leave_date asc, a.allocation_id asc
           ),
           '[]'::jsonb
         )
    into v_allocations
    from public.leave_request_lot_allocations a
    join public.leave_lots l on l.lot_id = a.lot_id
   where a.request_id = p_request.request_id;

  return pg_catalog.jsonb_build_object(
    'request_id', p_request.request_id,
    'app_user_id', p_request.app_user_id,
    'requester', v_requester,
    'status', p_request.status,
    'leave_types', v_leave_types,
    'type_breakdown', v_type_breakdown,
    'requested_units', p_request.requested_units,
    'requested_annual_units', v_requested_annual_units,
    'requested_non_annual_units', v_requested_non_annual_units,
    'employment_status_snapshot', p_request.employment_status_snapshot,
    'unit_kind_snapshot', p_request.unit_kind_snapshot,
    'profile_configured_at_submit', p_request.profile_configured_at_submit,
    'reason', p_request.reason,
    'route_kind', p_request.route_kind,
    'primary_approver_app_user_id', p_request.primary_approver_app_user_id,
    'primary_approver', v_primary_approver,
    'routed_team_id', p_request.routed_team_id,
    'routed_team_code', p_request.routed_team_code,
    'routed_team_name', p_request.routed_team_name,
    'fallback_reason', p_request.fallback_reason,
    'submitted_at', p_request.submitted_at,
    'decided_at', p_request.decided_at,
    'decided_by_app_user_id', p_request.decided_by_app_user_id,
    'decided_by', v_decided_by,
    'decision_reason', p_request.decision_reason,
    'cancelled_at', p_request.cancelled_at,
    'cancelled_by_app_user_id', p_request.cancelled_by_app_user_id,
    'cancellation_reason', p_request.cancellation_reason,
    'row_version', p_request.row_version,
    'days', v_days,
    'allocations', v_allocations
  );
end;
$function$;

-- =====================================================================
-- 3. CREATE & DECIDE LEAVE REQUEST RPCS
-- =====================================================================

create or replace function public.leave_management_create_request(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_days jsonb,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_reason text := null;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_profile public.leave_employee_profiles%rowtype;
  v_has_profile boolean := false;
  v_profile_configured boolean := false;
  v_emp_status_snapshot text;
  v_unit_kind_snapshot text;
  v_routing jsonb;
  v_raw_days jsonb;
  v_raw_allocs jsonb := null;
  v_day_item jsonb;
  v_day_date_text text;
  v_day_date date;
  v_session_code text;
  v_explicit_leave_type text;
  v_item_units integer;
  v_half_day_units integer;
  v_total_units integer := 0;
  v_seq integer := 0;
  v_alloc_item jsonb;
  v_alloc_seq integer := 0;
  v_alloc_type text;
  v_alloc_units integer;
  v_alloc_days numeric;
  v_alloc_total_units integer := 0;
  v_has_explicit_day_types boolean := false;
  v_all_days_have_explicit_types boolean := true;
  v_mismatch_count integer := 0;
  v_annual_units integer := 0;
  v_sim_lot record;
  v_sim_needed integer;
  v_request_row public.leave_requests%rowtype;
  v_projected_request jsonb;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if coalesce((v_auth->>'is_shared_non_employee')::boolean, false) then
    raise exception 'LEAVE_SHARED_ACCOUNT_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  v_reason := case
    when nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null then null
    else public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID')
  end;

  perform public.leave_management__internal_lock_employee(p_actor_app_user_id);

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'CREATE_REQUEST'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  perform public.leave_management__internal_sync_employee_accruals(p_actor_app_user_id, v_today);

  if p_days is null then
    raise exception 'LEAVE_REQUEST_DAYS_INVALID'
      using errcode = '22023';
  elsif pg_catalog.jsonb_typeof(p_days) = 'object' then
    v_raw_days := p_days->'days';
    v_raw_allocs := coalesce(p_days->'type_allocations', p_days->'allocations');
  elsif pg_catalog.jsonb_typeof(p_days) = 'array' then
    v_raw_days := p_days;
    v_raw_allocs := null;
  else
    raise exception 'LEAVE_REQUEST_DAYS_INVALID'
      using errcode = '22023';
  end if;

  if v_raw_days is null
     or pg_catalog.jsonb_typeof(v_raw_days) <> 'array'
     or pg_catalog.jsonb_array_length(v_raw_days) < 1
     or pg_catalog.jsonb_array_length(v_raw_days) > 120 then
    raise exception 'LEAVE_REQUEST_DAYS_INVALID'
      using errcode = '22023';
  end if;

  create temporary table if not exists pg_temp.leave_req_input_days (
    seq_no integer primary key,
    leave_date date not null,
    session_code text not null,
    half_day_units integer not null,
    explicit_leave_type text null
  ) on commit drop;

  create temporary table if not exists pg_temp.leave_req_normalized_days (
    seq_no integer primary key,
    leave_date date not null,
    session_code text not null,
    half_day_units integer not null,
    leave_type text not null
  ) on commit drop;

  truncate table pg_temp.leave_req_input_days;
  truncate table pg_temp.leave_req_normalized_days;

  for v_day_item in
    select value
      from pg_catalog.jsonb_array_elements(v_raw_days)
  loop
    if pg_catalog.jsonb_typeof(v_day_item) <> 'object' then
      raise exception 'LEAVE_REQUEST_DAYS_INVALID'
        using errcode = '22023';
    end if;

    v_seq := v_seq + 1;
    v_day_date_text := pg_catalog.btrim(coalesce(v_day_item->>'leave_date', ''));
    v_session_code := pg_catalog.upper(pg_catalog.btrim(coalesce(v_day_item->>'session_code', '')));
    v_explicit_leave_type := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(v_day_item->>'leave_type', ''))), '');

    if v_day_date_text !~ '^\d{4}-\d{2}-\d{2}$'
       or v_session_code not in ('FULL', 'AM', 'PM') then
      raise exception 'LEAVE_REQUEST_DAYS_INVALID'
        using errcode = '22023';
    end if;

    if v_explicit_leave_type is not null then
      if v_explicit_leave_type not in ('ANNUAL', 'BEREAVEMENT', 'MARRIAGE', 'SICK', 'UNPAID') then
        raise exception 'LEAVE_TYPE_INVALID'
          using errcode = '22023';
      end if;
      v_has_explicit_day_types := true;
    else
      v_all_days_have_explicit_types := false;
    end if;

    begin
      v_day_date := v_day_date_text::date;
    exception
      when others then
        raise exception 'LEAVE_REQUEST_DAYS_INVALID'
          using errcode = '22023';
    end;

    if pg_catalog.date_part('year', v_day_date)::integer <> v_year then
      raise exception 'LEAVE_REQUEST_YEAR_OUT_OF_RANGE'
        using errcode = '22023';
    end if;

    v_half_day_units := case when v_session_code = 'FULL' then 2 else 1 end;

    if v_day_item ? 'half_day_units' and pg_catalog.jsonb_typeof(v_day_item->'half_day_units') <> 'null' then
      begin
        v_item_units := (v_day_item->>'half_day_units')::integer;
      exception
        when others then
          raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
            using errcode = '22023';
      end;

      if v_item_units is distinct from v_half_day_units then
        raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
          using errcode = '22023';
      end if;
    end if;

    if exists (
      select 1
        from pg_temp.leave_req_input_days i
       where i.leave_date = v_day_date
         and (
           i.session_code = 'FULL'
           or v_session_code = 'FULL'
           or i.session_code = v_session_code
           or coalesce(i.explicit_leave_type, 'ANNUAL') = coalesce(v_explicit_leave_type, 'ANNUAL')
         )
    ) then
      raise exception 'LEAVE_REQUEST_DUPLICATE_DATE'
        using errcode = '22023';
    end if;

    if exists (
      select 1
        from public.leave_request_days d
       where d.app_user_id = p_actor_app_user_id
         and d.leave_date = v_day_date
         and d.is_active = true
         and (
           d.session_code = 'FULL'
           or v_session_code = 'FULL'
           or d.session_code = v_session_code
         )
    ) then
      raise exception 'LEAVE_REQUEST_OVERLAP'
        using errcode = '23505';
    end if;

    insert into pg_temp.leave_req_input_days (
      seq_no,
      leave_date,
      session_code,
      half_day_units,
      explicit_leave_type
    )
    values (
      v_seq,
      v_day_date,
      v_session_code,
      v_half_day_units,
      v_explicit_leave_type
    );

    v_total_units := v_total_units + v_half_day_units;
  end loop;

  if v_raw_allocs is not null and pg_catalog.jsonb_typeof(v_raw_allocs) <> 'null' then
    if pg_catalog.jsonb_typeof(v_raw_allocs) <> 'array'
       or pg_catalog.jsonb_array_length(v_raw_allocs) < 1
       or pg_catalog.jsonb_array_length(v_raw_allocs) > 20 then
      raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
        using errcode = '22023';
    end if;

    create temporary table if not exists pg_temp.leave_req_type_allocs (
      alloc_seq integer primary key,
      leave_type text not null,
      half_day_units integer not null
    ) on commit drop;

    truncate table pg_temp.leave_req_type_allocs;

    for v_alloc_item in
      select value
        from pg_catalog.jsonb_array_elements(v_raw_allocs)
    loop
      if pg_catalog.jsonb_typeof(v_alloc_item) <> 'object' then
        raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
          using errcode = '22023';
      end if;

      v_alloc_seq := v_alloc_seq + 1;
      v_alloc_type := pg_catalog.upper(pg_catalog.btrim(coalesce(v_alloc_item->>'leave_type', '')));

      if v_alloc_type not in ('ANNUAL', 'BEREAVEMENT', 'MARRIAGE', 'SICK', 'UNPAID') then
        raise exception 'LEAVE_TYPE_INVALID'
          using errcode = '22023';
      end if;

      v_alloc_units := null;
      if v_alloc_item ? 'half_day_units' and pg_catalog.jsonb_typeof(v_alloc_item->'half_day_units') <> 'null' then
        begin
          v_alloc_units := (v_alloc_item->>'half_day_units')::integer;
        exception
          when others then
            raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
              using errcode = '22023';
        end;
      end if;

      if v_alloc_item ? 'days' and pg_catalog.jsonb_typeof(v_alloc_item->'days') <> 'null' then
        begin
          v_alloc_days := (v_alloc_item->>'days')::numeric;
        exception
          when others then
            raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
              using errcode = '22023';
        end;

        if v_alloc_days <= 0 or pg_catalog.mod(v_alloc_days * 2, 1) <> 0 then
          raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
            using errcode = '22023';
        end if;

        if v_alloc_units is not null and v_alloc_units <> (v_alloc_days * 2)::integer then
          raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
            using errcode = '22023';
        end if;

        v_alloc_units := (v_alloc_days * 2)::integer;
      end if;

      if v_alloc_units is null or v_alloc_units < 1 then
        raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
          using errcode = '22023';
      end if;

      insert into pg_temp.leave_req_type_allocs (
        alloc_seq,
        leave_type,
        half_day_units
      )
      values (
        v_alloc_seq,
        v_alloc_type,
        v_alloc_units
      );

      v_alloc_total_units := v_alloc_total_units + v_alloc_units;
    end loop;

    if v_alloc_total_units <> v_total_units then
      raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
        using errcode = '22023';
    end if;

    if v_has_explicit_day_types then
      if not v_all_days_have_explicit_types then
        raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
          using errcode = '22023';
      end if;

      select count(*)::integer
        into v_mismatch_count
        from (
          select i.explicit_leave_type as leave_type,
                 sum(i.half_day_units)::integer as day_units
            from pg_temp.leave_req_input_days i
           group by i.explicit_leave_type
        ) d_sum
        full outer join (
          select a.leave_type,
                 sum(a.half_day_units)::integer as alloc_units
            from pg_temp.leave_req_type_allocs a
           group by a.leave_type
        ) a_sum on a_sum.leave_type = d_sum.leave_type
       where coalesce(d_sum.day_units, 0) <> coalesce(a_sum.alloc_units, 0);

      if v_mismatch_count > 0 then
        raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
          using errcode = '22023';
      end if;

      insert into pg_temp.leave_req_normalized_days (
        seq_no,
        leave_date,
        session_code,
        half_day_units,
        leave_type
      )
      select pg_catalog.row_number() over (
               order by i.leave_date asc,
                        case i.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                        i.seq_no asc
             )::integer,
             i.leave_date,
             i.session_code,
             i.half_day_units,
             i.explicit_leave_type
        from pg_temp.leave_req_input_days i;
    else
      -- Distribute type_allocations across ordered half-day slots of the requested days
      insert into pg_temp.leave_req_normalized_days (
        seq_no,
        leave_date,
        session_code,
        half_day_units,
        leave_type
      )
      with expanded_day_slots as (
        select pg_catalog.row_number() over (
                 order by i.leave_date asc,
                          case i.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                          i.seq_no asc,
                          s.slot_idx asc
               )::integer as slot_no,
               i.seq_no as orig_seq_no,
               i.leave_date,
               i.session_code as orig_session_code,
               case
                 when i.session_code = 'FULL' and s.slot_idx = 1 then 'AM'
                 when i.session_code = 'FULL' and s.slot_idx = 2 then 'PM'
                 else i.session_code
               end as slot_session_code
          from pg_temp.leave_req_input_days i
          cross join lateral pg_catalog.generate_series(1, i.half_day_units) as s(slot_idx)
      ),
      expanded_alloc_slots as (
        select pg_catalog.row_number() over (
                 order by a.alloc_seq asc, s.slot_idx asc
               )::integer as slot_no,
               a.leave_type
          from pg_temp.leave_req_type_allocs a
          cross join lateral pg_catalog.generate_series(1, a.half_day_units) as s(slot_idx)
      ),
      assigned_slots as (
        select d.slot_no,
               d.orig_seq_no,
               d.leave_date,
               d.orig_session_code,
               d.slot_session_code,
               a.leave_type
          from expanded_day_slots d
          join expanded_alloc_slots a on a.slot_no = d.slot_no
      ),
      merged_days as (
        select min(s.slot_no) as first_slot_no,
               s.leave_date,
               'FULL'::text as session_code,
               2::integer as half_day_units,
               min(s.leave_type) as leave_type
          from assigned_slots s
         where s.orig_session_code = 'FULL'
         group by s.orig_seq_no, s.leave_date
        having count(distinct s.leave_type) = 1
        union all
        select s.slot_no as first_slot_no,
               s.leave_date,
               s.slot_session_code as session_code,
               1::integer as half_day_units,
               s.leave_type
          from assigned_slots s
         where s.orig_session_code <> 'FULL'
            or s.orig_seq_no in (
              select s2.orig_seq_no
                from assigned_slots s2
               where s2.orig_session_code = 'FULL'
               group by s2.orig_seq_no
              having count(distinct s2.leave_type) > 1
            )
      )
      select pg_catalog.row_number() over (
               order by m.leave_date asc,
                        case m.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                        m.first_slot_no asc
             )::integer,
             m.leave_date,
             m.session_code,
             m.half_day_units,
             m.leave_type
        from merged_days m;
    end if;
  else
    insert into pg_temp.leave_req_normalized_days (
      seq_no,
      leave_date,
      session_code,
      half_day_units,
      leave_type
    )
    select pg_catalog.row_number() over (
             order by i.leave_date asc,
                      case i.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                      i.seq_no asc
           )::integer,
           i.leave_date,
           i.session_code,
           i.half_day_units,
           coalesce(i.explicit_leave_type, 'ANNUAL')
      from pg_temp.leave_req_input_days i;
  end if;

  -- Enforce per-request limits by leave_type:
  -- BEREAVEMENT, MARRIAGE: max 3 days (6 half-day units) per request
  -- SICK, UNPAID: max 7 days (14 half-day units) per request
  if exists (
    select 1
      from (
        select n.leave_type,
               sum(n.half_day_units)::integer as type_units
          from pg_temp.leave_req_normalized_days n
         group by n.leave_type
      ) s
     where (s.leave_type in ('BEREAVEMENT', 'MARRIAGE') and s.type_units > 6)
        or (s.leave_type in ('SICK', 'UNPAID') and s.type_units > 14)
  ) then
    raise exception 'LEAVE_TYPE_LIMIT_EXCEEDED'
      using errcode = '22023';
  end if;

  select p.*
    into v_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_actor_app_user_id;

  if found then
    v_has_profile := true;
    v_profile_configured := (
      not v_profile.is_shared_non_employee
      and v_profile.employment_status in ('PROBATION', 'OFFICIAL')
      and v_profile.work_start_date is not null
      and (
        v_profile.employment_status <> 'OFFICIAL'
        or v_profile.official_effective_date is not null
      )
    );
    v_emp_status_snapshot := v_profile.employment_status;
    v_unit_kind_snapshot := v_profile.unit_kind;
  else
    v_emp_status_snapshot := 'UNCONFIGURED';
    v_unit_kind_snapshot := 'UNCLASSIFIED';
  end if;

  -- Verify FIFO balance availability across eligible lots strictly for ANNUAL leave units
  select coalesce(sum(n.half_day_units), 0)::integer
    into v_annual_units
    from pg_temp.leave_req_normalized_days n
   where n.leave_type = 'ANNUAL';

  if v_annual_units > 0 then
    create temporary table if not exists pg_temp.leave_sim_lots (
      lot_id uuid primary key,
      usable_from_date date not null,
      expires_after_date date null,
      created_at timestamptz not null,
      remaining_units integer not null
    ) on commit drop;

    truncate table pg_temp.leave_sim_lots;

    insert into pg_temp.leave_sim_lots (
      lot_id,
      usable_from_date,
      expires_after_date,
      created_at,
      remaining_units
    )
    select l.lot_id,
           l.usable_from_date,
           l.expires_after_date,
           l.created_at,
           (l.granted_units - l.reserved_units - l.consumed_units - l.expired_units)
      from public.leave_lots l
     where l.app_user_id = p_actor_app_user_id
       and l.leave_year = v_year
       and (l.granted_units - l.reserved_units - l.consumed_units - l.expired_units) > 0;

    for v_day_date, v_half_day_units in
      select n.leave_date,
             n.half_day_units
        from pg_temp.leave_req_normalized_days n
       where n.leave_type = 'ANNUAL'
       order by n.leave_date asc, n.seq_no asc
    loop
      v_sim_needed := v_half_day_units;
      for v_sim_lot in
        select s.lot_id,
               s.remaining_units
          from pg_temp.leave_sim_lots s
         where s.remaining_units > 0
           and s.usable_from_date <= v_day_date
           and (s.expires_after_date is null or v_day_date <= s.expires_after_date)
         order by s.expires_after_date asc nulls last,
                  s.usable_from_date asc,
                  s.created_at asc,
                  s.lot_id asc
      loop
        if v_sim_lot.remaining_units >= v_sim_needed then
          update pg_temp.leave_sim_lots
             set remaining_units = remaining_units - v_sim_needed
           where lot_id = v_sim_lot.lot_id;
          v_sim_needed := 0;
          exit;
        else
          v_sim_needed := v_sim_needed - v_sim_lot.remaining_units;
          update pg_temp.leave_sim_lots
             set remaining_units = 0
           where lot_id = v_sim_lot.lot_id;
        end if;
      end loop;

      if v_sim_needed > 0 then
        raise exception 'LEAVE_INSUFFICIENT_BALANCE'
          using errcode = '22023';
      end if;
    end loop;
  end if;

  v_routing := public.leave_management__internal_resolve_routing(p_actor_app_user_id, v_today);

  insert into public.leave_requests (
    app_user_id,
    status,
    pay_treatment,
    employment_status_snapshot,
    unit_kind_snapshot,
    profile_configured_at_submit,
    requested_units,
    reason,
    route_kind,
    primary_approver_app_user_id,
    routed_team_id,
    routed_team_code,
    routed_team_name,
    fallback_reason,
    row_version
  )
  values (
    p_actor_app_user_id,
    'PENDING',
    null,
    v_emp_status_snapshot,
    coalesce(v_routing->>'unit_kind', v_unit_kind_snapshot),
    v_profile_configured,
    v_total_units,
    v_reason,
    v_routing->>'route_kind',
    nullif(v_routing->>'primary_approver_app_user_id', '')::uuid,
    nullif(v_routing->>'team_id', '')::uuid,
    nullif(v_routing->>'team_code', ''),
    nullif(v_routing->>'team_name', ''),
    nullif(v_routing->>'fallback_reason', ''),
    1
  )
  returning * into v_request_row;

  begin
    insert into public.leave_request_days (
      request_id,
      app_user_id,
      leave_date,
      session_code,
      leave_type,
      half_day_units,
      is_active
    )
    select v_request_row.request_id,
           p_actor_app_user_id,
           n.leave_date,
           n.session_code,
           n.leave_type,
           n.half_day_units,
           true
      from pg_temp.leave_req_normalized_days n
     order by n.leave_date asc,
              case n.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
              n.seq_no asc;
  exception
    when unique_violation then
      raise exception 'LEAVE_REQUEST_OVERLAP'
        using errcode = '23505';
  end;

  v_projected_request := public.leave_management__internal_project_request(v_request_row);

  insert into public.leave_audit_events (
    event_type,
    actor_app_user_id,
    target_app_user_id,
    request_id,
    reason,
    payload
  )
  values (
    'REQUEST_CREATED',
    p_actor_app_user_id,
    p_actor_app_user_id,
    v_request_row.request_id,
    v_reason,
    pg_catalog.jsonb_build_object(
      'leave_types', v_projected_request->'leave_types',
      'type_breakdown', v_projected_request->'type_breakdown',
      'requested_units', v_total_units,
      'requested_annual_units', v_annual_units,
      'route_kind', v_request_row.route_kind,
      'primary_approver_app_user_id', v_request_row.primary_approver_app_user_id,
      'fallback_reason', v_request_row.fallback_reason
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'request', v_projected_request,
    'balance', public.leave_management__internal_compute_balance_summary(p_actor_app_user_id, v_year, v_today)
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'CREATE_REQUEST',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

create or replace function public.leave_management_decide_request(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_request_id uuid,
  p_decision text,
  p_expected_row_version integer,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_decision text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_decision, '')));
  v_reason text := null;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_req public.leave_requests%rowtype;
  v_day record;
  v_lot record;
  v_alloc record;
  v_needed integer;
  v_lot_avail integer;
  v_take integer;
  v_alloc_status text;
  v_entry_type text;
  v_projected_request jsonb;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if coalesce((v_auth->>'is_shared_non_employee')::boolean, false) then
    raise exception 'LEAVE_SHARED_ACCOUNT_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  if v_decision not in ('APPROVE', 'REJECT', 'CANCEL_APPROVED') then
    raise exception 'LEAVE_DECISION_INVALID'
      using errcode = '22023';
  end if;

  v_reason := case
    when nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null then null
    else public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID')
  end;

  select r.*
    into v_req
    from public.leave_requests r
   where r.request_id = p_request_id;

  if not found then
    raise exception 'LEAVE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  perform public.leave_management__internal_lock_employee(v_req.app_user_id);

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'DECIDE_REQUEST'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select r.*
    into v_req
    from public.leave_requests r
   where r.request_id = p_request_id
   for update;

  if p_actor_app_user_id = v_req.app_user_id then
    raise exception 'LEAVE_SELF_APPROVAL_FORBIDDEN'
      using errcode = '42501';
  end if;

  if not public.leave_management__internal_can_actor_decide_request(p_actor_app_user_id, v_req, v_today) then
    raise exception 'LEAVE_APPROVAL_FORBIDDEN'
      using errcode = '42501';
  end if;

  if p_expected_row_version is null or v_req.row_version <> p_expected_row_version then
    raise exception 'LEAVE_ROW_VERSION_CONFLICT'
      using errcode = '40001';
  end if;

  perform public.leave_management__internal_sync_employee_accruals(v_req.app_user_id, v_today);

  if v_decision = 'APPROVE' then
    if v_req.status <> 'PENDING' then
      raise exception 'LEAVE_INVALID_STATE_TRANSITION'
        using errcode = '22023';
    end if;

    -- Strictly deduct/reserve FIFO lots only for ANNUAL leave days
    for v_day in
      select d.request_day_id,
             d.leave_date,
             d.session_code,
             d.leave_type,
             d.half_day_units
        from public.leave_request_days d
       where d.request_id = v_req.request_id
         and d.leave_type = 'ANNUAL'
       order by d.leave_date asc,
                case d.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                d.request_day_id asc
    loop
      v_needed := v_day.half_day_units;

      for v_lot in
        select l.*
          from public.leave_lots l
         where l.app_user_id = v_req.app_user_id
           and l.usable_from_date <= v_day.leave_date
           and (l.expires_after_date is null or v_day.leave_date <= l.expires_after_date)
           and (l.granted_units - l.reserved_units - l.consumed_units - l.expired_units) > 0
         order by l.expires_after_date asc nulls last,
                  l.usable_from_date asc,
                  l.created_at asc,
                  l.lot_id asc
         for update
      loop
        v_lot_avail := v_lot.granted_units - v_lot.reserved_units - v_lot.consumed_units - v_lot.expired_units;
        if v_lot_avail <= 0 then
          continue;
        end if;

        v_take := least(v_needed, v_lot_avail);

        if v_day.leave_date <= v_today then
          v_alloc_status := 'CONSUMED';
          v_entry_type := 'CONSUME';

          update public.leave_lots
             set consumed_units = consumed_units + v_take,
                 updated_at = pg_catalog.timezone('utc', pg_catalog.now())
           where lot_id = v_lot.lot_id;

          insert into public.leave_request_lot_allocations (
            request_id,
            request_day_id,
            lot_id,
            leave_date,
            allocated_units,
            status,
            settled_at
          )
          values (
            v_req.request_id,
            v_day.request_day_id,
            v_lot.lot_id,
            v_day.leave_date,
            v_take,
            v_alloc_status,
            pg_catalog.timezone('utc', pg_catalog.now())
          );

          insert into public.leave_ledger_entries (
            app_user_id,
            lot_id,
            request_id,
            request_day_id,
            entry_type,
            effective_date,
            delta_available_units,
            delta_reserved_units,
            delta_consumed_units,
            delta_expired_units,
            actor_app_user_id,
            reason,
            metadata
          )
          values (
            v_req.app_user_id,
            v_lot.lot_id,
            v_req.request_id,
            v_day.request_day_id,
            v_entry_type,
            v_day.leave_date,
            -v_take,
            0,
            v_take,
            0,
            p_actor_app_user_id,
            coalesce(v_reason, 'Duyệt đơn nghỉ phép năm (trừ phép trực tiếp)'),
            pg_catalog.jsonb_build_object(
              'leave_date', v_day.leave_date,
              'session_code', v_day.session_code,
              'leave_type', v_day.leave_type,
              'lot_kind', v_lot.lot_kind
            )
          );
        else
          v_alloc_status := 'RESERVED';
          v_entry_type := 'RESERVE';

          update public.leave_lots
             set reserved_units = reserved_units + v_take,
                 updated_at = pg_catalog.timezone('utc', pg_catalog.now())
           where lot_id = v_lot.lot_id;

          insert into public.leave_request_lot_allocations (
            request_id,
            request_day_id,
            lot_id,
            leave_date,
            allocated_units,
            status,
            settled_at
          )
          values (
            v_req.request_id,
            v_day.request_day_id,
            v_lot.lot_id,
            v_day.leave_date,
            v_take,
            v_alloc_status,
            null
          );

          insert into public.leave_ledger_entries (
            app_user_id,
            lot_id,
            request_id,
            request_day_id,
            entry_type,
            effective_date,
            delta_available_units,
            delta_reserved_units,
            delta_consumed_units,
            delta_expired_units,
            actor_app_user_id,
            reason,
            metadata
          )
          values (
            v_req.app_user_id,
            v_lot.lot_id,
            v_req.request_id,
            v_day.request_day_id,
            v_entry_type,
            v_day.leave_date,
            -v_take,
            v_take,
            0,
            0,
            p_actor_app_user_id,
            coalesce(v_reason, 'Duyệt đơn nghỉ phép năm (giữ chỗ ngày tương lai)'),
            pg_catalog.jsonb_build_object(
              'leave_date', v_day.leave_date,
              'session_code', v_day.session_code,
              'leave_type', v_day.leave_type,
              'lot_kind', v_lot.lot_kind
            )
          );
        end if;

        v_needed := v_needed - v_take;
        exit when v_needed = 0;
      end loop;

      if v_needed > 0 then
        raise exception 'LEAVE_INSUFFICIENT_BALANCE'
          using errcode = '22023';
      end if;
    end loop;

    update public.leave_requests
       set status = 'APPROVED',
           decided_at = pg_catalog.timezone('utc', pg_catalog.now()),
           decided_by_app_user_id = p_actor_app_user_id,
           decision_reason = v_reason,
           row_version = row_version + 1,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now())
     where request_id = v_req.request_id
     returning * into v_req;

    v_projected_request := public.leave_management__internal_project_request(v_req);

    insert into public.leave_audit_events (
      event_type,
      actor_app_user_id,
      target_app_user_id,
      request_id,
      reason,
      payload
    )
    values (
      'REQUEST_APPROVED',
      p_actor_app_user_id,
      v_req.app_user_id,
      v_req.request_id,
      v_reason,
      pg_catalog.jsonb_build_object(
        'leave_types', v_projected_request->'leave_types',
        'type_breakdown', v_projected_request->'type_breakdown',
        'requested_units', v_req.requested_units,
        'requested_annual_units', v_projected_request->'requested_annual_units',
        'row_version', v_req.row_version
      )
    );

  elsif v_decision = 'REJECT' then
    if v_req.status <> 'PENDING' then
      raise exception 'LEAVE_INVALID_STATE_TRANSITION'
        using errcode = '22023';
    end if;

    update public.leave_request_days
       set is_active = false
     where request_id = v_req.request_id;

    update public.leave_requests
       set status = 'REJECTED',
           decided_at = pg_catalog.timezone('utc', pg_catalog.now()),
           decided_by_app_user_id = p_actor_app_user_id,
           decision_reason = v_reason,
           row_version = row_version + 1,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now())
     where request_id = v_req.request_id
     returning * into v_req;

    v_projected_request := public.leave_management__internal_project_request(v_req);

    insert into public.leave_audit_events (
      event_type,
      actor_app_user_id,
      target_app_user_id,
      request_id,
      reason,
      payload
    )
    values (
      'REQUEST_REJECTED',
      p_actor_app_user_id,
      v_req.app_user_id,
      v_req.request_id,
      v_reason,
      pg_catalog.jsonb_build_object(
        'row_version', v_req.row_version
      )
    );

  elsif v_decision = 'CANCEL_APPROVED' then
    if v_req.status <> 'APPROVED' then
      raise exception 'LEAVE_INVALID_STATE_TRANSITION'
        using errcode = '22023';
    end if;

    for v_alloc in
      select a.*
        from public.leave_request_lot_allocations a
       where a.request_id = v_req.request_id
         and a.status in ('RESERVED', 'CONSUMED')
       order by a.allocation_id asc
       for update
    loop
      select l.*
        into v_lot
        from public.leave_lots l
       where l.lot_id = v_alloc.lot_id
       for update;

      if v_alloc.status = 'RESERVED' then
        update public.leave_request_lot_allocations
           set status = 'RELEASED',
               released_at = pg_catalog.timezone('utc', pg_catalog.now())
         where allocation_id = v_alloc.allocation_id;

        update public.leave_lots
           set reserved_units = reserved_units - v_alloc.allocated_units,
               updated_at = pg_catalog.timezone('utc', pg_catalog.now())
         where lot_id = v_lot.lot_id;

        insert into public.leave_ledger_entries (
          app_user_id,
          lot_id,
          request_id,
          request_day_id,
          entry_type,
          effective_date,
          delta_available_units,
          delta_reserved_units,
          delta_consumed_units,
          delta_expired_units,
          actor_app_user_id,
          reason,
          metadata
        )
        values (
          v_req.app_user_id,
          v_lot.lot_id,
          v_req.request_id,
          v_alloc.request_day_id,
          'RELEASE_RESERVE',
          v_today,
          v_alloc.allocated_units,
          -v_alloc.allocated_units,
          0,
          0,
          p_actor_app_user_id,
          v_reason,
          pg_catalog.jsonb_build_object(
            'allocation_id', v_alloc.allocation_id,
            'leave_date', v_alloc.leave_date
          )
        );
      else
        update public.leave_request_lot_allocations
           set status = 'REVERSED',
               released_at = pg_catalog.timezone('utc', pg_catalog.now())
         where allocation_id = v_alloc.allocation_id;

        update public.leave_lots
           set consumed_units = consumed_units - v_alloc.allocated_units,
               updated_at = pg_catalog.timezone('utc', pg_catalog.now())
         where lot_id = v_lot.lot_id;

        insert into public.leave_ledger_entries (
          app_user_id,
          lot_id,
          request_id,
          request_day_id,
          entry_type,
          effective_date,
          delta_available_units,
          delta_reserved_units,
          delta_consumed_units,
          delta_expired_units,
          actor_app_user_id,
          reason,
          metadata
        )
        values (
          v_req.app_user_id,
          v_lot.lot_id,
          v_req.request_id,
          v_alloc.request_day_id,
          'REVERSAL_CONSUME',
          v_today,
          v_alloc.allocated_units,
          0,
          -v_alloc.allocated_units,
          0,
          p_actor_app_user_id,
          v_reason,
          pg_catalog.jsonb_build_object(
            'allocation_id', v_alloc.allocation_id,
            'leave_date', v_alloc.leave_date
          )
        );
      end if;

      -- If the lot has already expired as of v_today, immediately expire the returned units
      if v_lot.expires_after_date is not null and v_lot.expires_after_date < v_today then
        update public.leave_lots
           set expired_units = expired_units + v_alloc.allocated_units,
               updated_at = pg_catalog.timezone('utc', pg_catalog.now())
         where lot_id = v_lot.lot_id;

        insert into public.leave_ledger_entries (
          app_user_id,
          lot_id,
          request_id,
          request_day_id,
          entry_type,
          effective_date,
          delta_available_units,
          delta_reserved_units,
          delta_consumed_units,
          delta_expired_units,
          actor_app_user_id,
          reason,
          metadata
        )
        values (
          v_req.app_user_id,
          v_lot.lot_id,
          v_req.request_id,
          v_alloc.request_day_id,
          'EXPIRE_CARRY_OVER',
          v_today,
          -v_alloc.allocated_units,
          0,
          0,
          v_alloc.allocated_units,
          p_actor_app_user_id,
          'Hết hạn ngay phần phép hoàn lại do lô phép chuyển năm đã quá hạn ' || v_lot.expires_after_date::text,
          pg_catalog.jsonb_build_object(
            'allocation_id', v_alloc.allocation_id,
            'expires_after_date', v_lot.expires_after_date
          )
        );
      end if;
    end loop;

    update public.leave_request_days
       set is_active = false
     where request_id = v_req.request_id;

    update public.leave_requests
       set status = 'CANCELLED',
           cancelled_at = pg_catalog.timezone('utc', pg_catalog.now()),
           cancelled_by_app_user_id = p_actor_app_user_id,
           cancellation_reason = v_reason,
           row_version = row_version + 1,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now())
     where request_id = v_req.request_id
     returning * into v_req;

    v_projected_request := public.leave_management__internal_project_request(v_req);

    insert into public.leave_audit_events (
      event_type,
      actor_app_user_id,
      target_app_user_id,
      request_id,
      reason,
      payload
    )
    values (
      'REQUEST_CANCELLED',
      p_actor_app_user_id,
      v_req.app_user_id,
      v_req.request_id,
      v_reason,
      pg_catalog.jsonb_build_object(
        'row_version', v_req.row_version
      )
    );
  end if;

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'request', v_projected_request,
    'requester_balance', public.leave_management__internal_compute_balance_summary(v_req.app_user_id, v_year, v_today)
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'DECIDE_REQUEST',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

-- =====================================================================
-- 4. MONTHLY ATTENDANCE & LEAVE CLOSING REPORT RPC
-- =====================================================================

create or replace function public.leave_management_monthly_report(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_year_month text,
  p_unit_kind_filter text default null,
  p_search text default null,
  p_limit integer default 200,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_auth jsonb;
  v_ym text := pg_catalog.btrim(coalesce(p_year_month, pg_catalog.to_char(v_today, 'YYYY-MM')));
  v_unit_filter text := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(p_unit_kind_filter, ''))), '');
  v_search text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, ''))), '');
  v_limit integer := greatest(1, least(coalesce(p_limit, 200), 500));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_month_start date;
  v_month_end date;
  v_year integer;
  v_month integer;
  v_sync_as_of date;
  v_page_user_ids uuid[] := array[]::uuid[];
  v_emp record;
  v_rows jsonb := '[]'::jsonb;
  v_total integer := 0;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_view_monthly_report')::boolean, false) then
    raise exception 'LEAVE_REPORT_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_ym !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'LEAVE_REPORT_YEAR_MONTH_INVALID'
      using errcode = '22023';
  end if;

  if v_unit_filter is not null
     and v_unit_filter not in ('ALL', 'UNCLASSIFIED', 'RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD') then
    raise exception 'LEAVE_FILTER_INVALID'
      using errcode = '22023';
  end if;

  v_month_start := (v_ym || '-01')::date;
  v_month_end := (v_month_start + interval '1 month - 1 day')::date;
  v_year := pg_catalog.date_part('year', v_month_start)::integer;
  v_month := pg_catalog.date_part('month', v_month_start)::integer;
  v_sync_as_of := least(v_today, v_month_end);

  select count(*)::integer
    into v_total
    from public.direct_entry_app_users u
    left join public.leave_employee_profiles p on p.app_user_id = u.app_user_id
    left join lateral (
      select r.display_name, r.personnel_code
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id
       where l.app_user_id = u.app_user_id
         and l.verified = true
         and l.is_current = true
       order by l.valid_from desc, l.link_id desc
       limit 1
    ) linked on true
   where coalesce(p.is_shared_non_employee, false) = false
     and (
       v_unit_filter is null
       or v_unit_filter = 'ALL'
       or coalesce(p.unit_kind, 'UNCLASSIFIED') = v_unit_filter
     )
     and (
       v_search is null
       or pg_catalog.lower(coalesce(linked.display_name, u.display_name, '')) like '%' || v_search || '%'
       or pg_catalog.lower(coalesce(linked.personnel_code, '')) like '%' || v_search || '%'
     );

  select coalesce(pg_catalog.array_agg(paged.app_user_id order by paged.sort_name asc, paged.app_user_id asc), array[]::uuid[])
    into v_page_user_ids
    from (
      select u.app_user_id,
             coalesce(linked.display_name, u.display_name) as sort_name
        from public.direct_entry_app_users u
        left join public.leave_employee_profiles p on p.app_user_id = u.app_user_id
        left join lateral (
          select r.display_name, r.personnel_code
            from public.direct_entry_app_user_recruiter_links l
            join public.recruiters r on r.recruiter_id = l.recruiter_id
           where l.app_user_id = u.app_user_id
             and l.verified = true
             and l.is_current = true
           order by l.valid_from desc, l.link_id desc
           limit 1
        ) linked on true
       where coalesce(p.is_shared_non_employee, false) = false
         and (
           v_unit_filter is null
           or v_unit_filter = 'ALL'
           or coalesce(p.unit_kind, 'UNCLASSIFIED') = v_unit_filter
         )
         and (
           v_search is null
           or pg_catalog.lower(coalesce(linked.display_name, u.display_name, '')) like '%' || v_search || '%'
           or pg_catalog.lower(coalesce(linked.personnel_code, '')) like '%' || v_search || '%'
         )
       order by coalesce(linked.display_name, u.display_name) asc, u.app_user_id asc
       limit v_limit
      offset v_offset
    ) paged;

  for v_emp in
    select u.app_user_id
      from public.direct_entry_app_users u
      left join public.leave_employee_profiles p on p.app_user_id = u.app_user_id
     where u.app_user_id = any(v_page_user_ids)
       and (
         (
           p.app_user_id is not null
           and p.is_shared_non_employee = false
           and p.employment_status = 'OFFICIAL'
           and p.work_start_date is not null
         )
         or exists (
           select 1
             from public.leave_lots l
            where l.app_user_id = u.app_user_id
         )
       )
     order by u.app_user_id asc
  loop
    perform public.leave_management__internal_sync_employee_accruals(v_emp.app_user_id, v_sync_as_of);
  end loop;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'app_user_id', sub.app_user_id,
               'account', sub.account,
               'routing', sub.routing,
               'employment_status', sub.employment_status,
               'unit_kind', sub.unit_kind,
               'work_start_date', sub.work_start_date,
               'official_effective_date', sub.official_effective_date,
               'attendance_day_count', sub.attendance_day_count,
               'attendance_dates', sub.attendance_dates,
               'attendance_days', sub.attendance_days,
               'leave_days', sub.leave_days,
               'pending_leave_days', sub.pending_leave_days,
               'month_annual_leave_units', sub.month_annual_leave_units,
               'month_bereavement_leave_units', sub.month_bereavement_leave_units,
               'month_marriage_leave_units', sub.month_marriage_leave_units,
               'month_sick_leave_units', sub.month_sick_leave_units,
               'month_unpaid_leave_units', sub.month_unpaid_leave_units,
               'month_total_approved_leave_units', sub.month_total_approved_leave_units,
               'month_pending_units', sub.month_pending_units,
               'month_approved_request_count', sub.month_approved_request_count,
               'balance', sub.balance
             )
             order by sub.sort_name asc, sub.app_user_id asc
           ),
           '[]'::jsonb
         )
    into v_rows
    from (
      select u.app_user_id,
             coalesce(linked.display_name, u.display_name) as sort_name,
             public.leave_management__internal_account_summary(u.app_user_id) as account,
             public.leave_management__internal_resolve_routing(u.app_user_id, v_sync_as_of) as routing,
             coalesce(p.employment_status, 'UNCONFIGURED') as employment_status,
             coalesce(p.unit_kind, 'UNCLASSIFIED') as unit_kind,
             p.work_start_date,
             p.official_effective_date,
             coalesce(att.attendance_day_count, 0)::integer as attendance_day_count,
             coalesce(att.attendance_dates, '[]'::jsonb) as attendance_dates,
             coalesce(att.attendance_days, '[]'::jsonb) as attendance_days,
             coalesce(m.leave_days, '[]'::jsonb) as leave_days,
             coalesce(m.pending_leave_days, '[]'::jsonb) as pending_leave_days,
             coalesce(m.annual_units, 0)::integer as month_annual_leave_units,
             coalesce(m.bereavement_units, 0)::integer as month_bereavement_leave_units,
             coalesce(m.marriage_units, 0)::integer as month_marriage_leave_units,
             coalesce(m.sick_units, 0)::integer as month_sick_leave_units,
             coalesce(m.unpaid_units, 0)::integer as month_unpaid_leave_units,
             coalesce(m.total_approved_units, 0)::integer as month_total_approved_leave_units,
             coalesce(m.pending_units, 0)::integer as month_pending_units,
             coalesce(m.approved_request_count, 0)::integer as month_approved_request_count,
             public.leave_management__internal_compute_balance_summary(u.app_user_id, v_year, v_sync_as_of) as balance
        from public.direct_entry_app_users u
        left join public.leave_employee_profiles p on p.app_user_id = u.app_user_id
        left join lateral (
          select r.display_name, r.personnel_code
            from public.direct_entry_app_user_recruiter_links l
            join public.recruiters r on r.recruiter_id = l.recruiter_id
           where l.app_user_id = u.app_user_id
             and l.verified = true
             and l.is_current = true
           order by l.valid_from desc, l.link_id desc
           limit 1
        ) linked on true
        left join lateral (
          select count(*)::integer as attendance_day_count,
                 coalesce(
                   pg_catalog.jsonb_agg(day_row.business_date order by day_row.business_date asc),
                   '[]'::jsonb
                 ) as attendance_dates,
                 coalesce(
                   pg_catalog.jsonb_agg(
                     pg_catalog.jsonb_build_object(
                       'business_date', day_row.business_date,
                       'checkin_count', day_row.checkin_count,
                       'first_captured_at', day_row.first_captured_at,
                       'last_captured_at', day_row.last_captured_at
                     )
                     order by day_row.business_date asc
                   ),
                   '[]'::jsonb
                 ) as attendance_days
            from (
              select ac.business_date,
                     count(*)::integer as checkin_count,
                     min(ac.captured_at) as first_captured_at,
                     max(ac.captured_at) as last_captured_at
                from public.attendance_checkins ac
               where ac.app_user_id = u.app_user_id
                 and ac.business_date between v_month_start and v_month_end
               group by ac.business_date
            ) day_row
        ) att on true
        left join lateral (
          select coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and d.leave_type = 'ANNUAL'),
                   0
                 ) as annual_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and d.leave_type = 'BEREAVEMENT'),
                   0
                 ) as bereavement_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and d.leave_type = 'MARRIAGE'),
                   0
                 ) as marriage_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and d.leave_type = 'SICK'),
                   0
                 ) as sick_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and d.leave_type = 'UNPAID'),
                   0
                 ) as unpaid_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED'),
                   0
                 ) as total_approved_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'PENDING'),
                   0
                 ) as pending_units,
                 count(distinct req.request_id)
                   filter (where req.status = 'APPROVED') as approved_request_count,
                 coalesce(
                   pg_catalog.jsonb_agg(
                     pg_catalog.jsonb_build_object(
                       'request_id', req.request_id,
                       'request_day_id', d.request_day_id,
                       'leave_date', d.leave_date,
                       'session_code', d.session_code,
                       'leave_type', d.leave_type,
                       'half_day_units', d.half_day_units
                     )
                     order by d.leave_date asc,
                              case d.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                              d.request_day_id asc
                   ) filter (where req.status = 'APPROVED'),
                   '[]'::jsonb
                 ) as leave_days,
                 coalesce(
                   pg_catalog.jsonb_agg(
                     pg_catalog.jsonb_build_object(
                       'request_id', req.request_id,
                       'request_day_id', d.request_day_id,
                       'leave_date', d.leave_date,
                       'session_code', d.session_code,
                       'leave_type', d.leave_type,
                       'half_day_units', d.half_day_units
                     )
                     order by d.leave_date asc,
                              case d.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                              d.request_day_id asc
                   ) filter (where req.status = 'PENDING'),
                   '[]'::jsonb
                 ) as pending_leave_days
            from public.leave_request_days d
            join public.leave_requests req on req.request_id = d.request_id
           where d.app_user_id = u.app_user_id
             and d.leave_date between v_month_start and v_month_end
        ) m on true
       where u.app_user_id = any(v_page_user_ids)
    ) sub;

  return pg_catalog.jsonb_build_object(
    'year_month', v_ym,
    'leave_year', v_year,
    'month', v_month,
    'as_of_date', v_sync_as_of,
    'unit_kind_filter', coalesce(v_unit_filter, 'ALL'),
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'rows', v_rows
  );
end;
$function$;

-- =====================================================================
-- 5. OWNER ALIGNMENT, TABLE/FUNCTION ACL, AND INSTALL-TIME SELF-CHECK
-- =====================================================================

do $owner_align$
declare
  v_base_owner_oid oid;
  v_owner name;
  v_tbl text;
  v_rel_owner_oid oid;
  v_fn regprocedure;
  v_proc_owner_oid oid;
  v_fn_owner name;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_owner is null then
    raise exception 'LEAVE_WP1_OWNER_RESOLUTION_FAILED';
  end if;

  foreach v_tbl in array array[
    'leave_policy_configs',
    'leave_policy_revisions',
    'leave_employee_profiles',
    'leave_department_approvers',
    'leave_module_grants',
    'leave_opening_batches',
    'leave_lots',
    'leave_requests',
    'leave_request_days',
    'leave_request_lot_allocations',
    'leave_ledger_entries',
    'leave_audit_events',
    'leave_idempotency_records'
  ] loop
    select c.relowner
      into v_rel_owner_oid
      from pg_catalog.pg_class c
     where c.oid = pg_catalog.to_regclass('public.' || v_tbl);

    if v_rel_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter table public.%I owner to %I', v_tbl, v_owner);
    end if;
  end loop;

  for v_fn, v_proc_owner_oid in
    select p.oid::regprocedure, p.proowner
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'leave_management%'
  loop
    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_owner);
    end if;
  end loop;

  for v_fn_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and p.proname like 'leave_management%'
  loop
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_actor_mapping(uuid, uuid) to %I',
      v_fn_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_capability(uuid, text) to %I',
      v_fn_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_scope(uuid, text) to %I',
      v_fn_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_authorization_date() to %I',
      v_fn_owner
    );
  end loop;
end;
$owner_align$;

revoke all on table
  public.leave_policy_configs,
  public.leave_policy_revisions,
  public.leave_employee_profiles,
  public.leave_department_approvers,
  public.leave_module_grants,
  public.leave_opening_batches,
  public.leave_lots,
  public.leave_requests,
  public.leave_request_days,
  public.leave_request_lot_allocations,
  public.leave_ledger_entries,
  public.leave_audit_events,
  public.leave_idempotency_records
from public, anon, authenticated, service_role;

revoke all on function
  public.leave_management__internal_immutable_guard(),
  public.leave_management__internal_business_date(),
  public.leave_management__internal_validate_reason(text, text),
  public.leave_management__internal_lock_employee(uuid),
  public.leave_management__internal_resolve_carry_over_expiry_date(integer, integer, integer),
  public.leave_management__internal_account_summary(uuid),
  public.leave_management__internal_resolve_authority(uuid, uuid),
  public.leave_management__internal_resolve_routing(uuid, date),
  public.leave_management__internal_can_actor_decide_request(uuid, public.leave_requests, date),
  public.leave_management__internal_sync_employee_accruals(uuid, date),
  public.leave_management__internal_compute_balance_summary(uuid, integer, date),
  public.leave_management__internal_project_request(public.leave_requests)
from public, anon, authenticated, service_role;

revoke all on function
  public.leave_management_get_my_summary(uuid, uuid, integer),
  public.leave_management_create_request(uuid, uuid, jsonb, text, text, text),
  public.leave_management_withdraw_request(uuid, uuid, uuid, integer, text, text, text),
  public.leave_management_list_approval_inbox(uuid, uuid, text, integer, integer),
  public.leave_management_decide_request(uuid, uuid, uuid, text, integer, text, text, text),
  public.leave_management_get_admin_overview(uuid, uuid, text, integer, integer),
  public.leave_management_update_policy_admin(uuid, uuid, integer, integer, integer, text, text, text),
  public.leave_management_upsert_employee_profile_admin(uuid, uuid, uuid, boolean, text, text, date, date, date, integer, integer, text, text, text),
  public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text),
  public.leave_management_manage_module_grant_admin(uuid, uuid, text, uuid, text, integer, text, text, text),
  public.leave_management_preview_opening_batch(uuid, uuid, integer, jsonb),
  public.leave_management_apply_opening_batch(uuid, uuid, integer, jsonb, text, text, text),
  public.leave_management_monthly_report(uuid, uuid, text, text, text, integer, integer)
from public, anon, authenticated, service_role;

grant execute on function
  public.leave_management_get_my_summary(uuid, uuid, integer),
  public.leave_management_create_request(uuid, uuid, jsonb, text, text, text),
  public.leave_management_withdraw_request(uuid, uuid, uuid, integer, text, text, text),
  public.leave_management_list_approval_inbox(uuid, uuid, text, integer, integer),
  public.leave_management_decide_request(uuid, uuid, uuid, text, integer, text, text, text),
  public.leave_management_get_admin_overview(uuid, uuid, text, integer, integer),
  public.leave_management_update_policy_admin(uuid, uuid, integer, integer, integer, text, text, text),
  public.leave_management_upsert_employee_profile_admin(uuid, uuid, uuid, boolean, text, text, date, date, date, integer, integer, text, text, text),
  public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text),
  public.leave_management_manage_module_grant_admin(uuid, uuid, text, uuid, text, integer, text, text, text),
  public.leave_management_preview_opening_batch(uuid, uuid, integer, jsonb),
  public.leave_management_apply_opening_batch(uuid, uuid, integer, jsonb, text, text, text),
  public.leave_management_monthly_report(uuid, uuid, text, text, text, integer, integer)
to service_role;

do $self_check$
declare
  v_unforced_rls integer;
  v_table_grants integer;
  v_bad_secdef integer;
  v_public_exec integer;
  v_service_exec integer;
  v_has_leave_type_col boolean;
begin
  select exists (
           select 1
             from information_schema.columns c
            where c.table_schema = 'public'
              and c.table_name = 'leave_request_days'
              and c.column_name = 'leave_type'
              and c.is_nullable = 'NO'
         )
    into v_has_leave_type_col;

  if not coalesce(v_has_leave_type_col, false) then
    raise exception 'LEAVE_TYPES_SELF_CHECK_COLUMN_MISSING';
  end if;

  select count(*)::integer
    into v_unforced_rls
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in (
       'leave_policy_configs',
       'leave_policy_revisions',
       'leave_employee_profiles',
       'leave_department_approvers',
       'leave_module_grants',
       'leave_opening_batches',
       'leave_lots',
       'leave_requests',
       'leave_request_days',
       'leave_request_lot_allocations',
       'leave_ledger_entries',
       'leave_audit_events',
       'leave_idempotency_records'
     )
     and (not c.relrowsecurity or not c.relforcerowsecurity);

  if v_unforced_rls <> 0 then
    raise exception 'LEAVE_WP1_SELF_CHECK_RLS_FAILED (% tables)', v_unforced_rls;
  end if;

  select count(*)::integer
    into v_table_grants
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name like 'leave_%'
     and g.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role');

  if v_table_grants <> 0 then
    raise exception 'LEAVE_WP1_SELF_CHECK_TABLE_GRANTS_FAILED (% grants)', v_table_grants;
  end if;

  select count(*)::integer
    into v_bad_secdef
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'leave_management%'
     and (
       not p.prosecdef
       or coalesce(pg_catalog.array_to_string(p.proconfig, ','), '') not like '%search_path=pg_catalog, public%'
     );

  if v_bad_secdef <> 0 then
    raise exception 'LEAVE_WP1_SELF_CHECK_SECDEF_FAILED (% functions)', v_bad_secdef;
  end if;

  select count(*)::integer
    into v_public_exec
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'leave_management%'
     and (
       pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
     );

  if v_public_exec <> 0 then
    raise exception 'LEAVE_WP1_SELF_CHECK_PUBLIC_EXEC_FAILED (% functions)', v_public_exec;
  end if;

  select count(*)::integer
    into v_service_exec
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'leave_management_%'
     and p.proname not like 'leave_management\_\_internal\_%' escape '\'
     and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE');

  if v_service_exec <> 13 then
    raise exception 'LEAVE_WP1_SELF_CHECK_SERVICE_EXEC_FAILED (expected 13, got %)', v_service_exec;
  end if;
end;
$self_check$;

commit;
