-- ============================================================================
-- Hotfix: Leave Opening Balance Target Reconciliation & Apply Response Contract
-- Scope:
--   1. Reconcile "opening_current_year_units" as the target current-year leave
--      balance at the cutoff date (as_of_date) rather than adding an extra lot
--      on top of automatic monthly accruals.
--   2. Allow target balances lower than automatic accruals (down to 0) when
--      unlocked balance is sufficient, while protecting consumed/reserved units
--      and preserving FIFO allocations.
--   3. Allow re-previewing and re-applying opening balance adjustments with
--      append-only ledger audit entries and stale-preview rejection.
--   4. Include top-level batch_id and applied_row_count in
--      public.leave_management_apply_opening_batch response.
-- ============================================================================

begin;

alter table public.leave_lots
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.leave_lots
  drop constraint if exists leave_lots_granted_units_chk;

alter table public.leave_lots
  add constraint leave_lots_granted_units_chk
  check (granted_units >= 0);

alter table public.leave_ledger_entries
  drop constraint if exists leave_ledger_entries_type_chk;

alter table public.leave_ledger_entries
  add constraint leave_ledger_entries_type_chk check (entry_type in (
    'GRANT_OPENING_CARRY_OVER',
    'GRANT_OPENING_CURRENT_YEAR',
    'ADJUST_OPENING_CURRENT_YEAR_INCREASE',
    'ADJUST_OPENING_CURRENT_YEAR_DECREASE',
    'GRANT_MONTHLY_ACCRUAL',
    'GRANT_PROBATION_CATCHUP',
    'GRANT_SENIORITY',
    'GRANT_MANUAL_ADJUSTMENT',
    'RESERVE',
    'SETTLE_RESERVE_TO_CONSUME',
    'CONSUME',
    'RELEASE_RESERVE',
    'REVERSAL_CONSUME',
    'EXPIRE_CARRY_OVER'
  ));

create table if not exists public.leave_opening_preview_snapshots (
  actor_app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete cascade,
  leave_year integer not null
    constraint leave_opening_preview_snapshots_year_chk
    check (leave_year between 2020 and 2100),
  rows_fingerprint text not null,
  as_of_date date not null,
  carry_over_expires_after_date date null,
  rows_state jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  consumed_at timestamptz null,
  primary key (actor_app_user_id, leave_year, rows_fingerprint)
);

alter table public.leave_opening_preview_snapshots enable row level security;
alter table public.leave_opening_preview_snapshots force row level security;

revoke all on table public.leave_opening_preview_snapshots
  from public, anon, authenticated, service_role;

create or replace function public.leave_management__internal_opening_rows_fingerprint(
  p_rows jsonb
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public
as $function$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ord', t.v_ord,
        'app_user_id', pg_catalog.lower(nullif(pg_catalog.btrim(coalesce(t.v_item->>'app_user_id', '')), '')),
        'carry_over_units', coalesce(
          case
            when coalesce(t.v_item->>'carry_over_units', '') ~ '^-?[0-9]+$'
              then (t.v_item->>'carry_over_units')::integer
            else -1
          end,
          0
        ),
        'opening_current_year_units', coalesce(
          case
            when coalesce(t.v_item->>'opening_current_year_units', '') ~ '^-?[0-9]+$'
              then (t.v_item->>'opening_current_year_units')::integer
            else -1
          end,
          0
        ),
        'seniority_units', coalesce(
          case
            when coalesce(t.v_item->>'seniority_units', '') ~ '^-?[0-9]+$'
              then (t.v_item->>'seniority_units')::integer
            else -1
          end,
          0
        ),
        'note', nullif(pg_catalog.btrim(coalesce(t.v_item->>'note', '')), '')
      )
      order by t.v_ord
    )::text,
    '[]'
  )
  from pg_catalog.jsonb_array_elements(
    case
      when p_rows is not null and pg_catalog.jsonb_typeof(p_rows) = 'array' then p_rows
      else '[]'::jsonb
    end
  ) with ordinality as t(v_item, v_ord);
$function$;

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
         coalesce(
           sum(coalesce((l.metadata->>'initial_granted_units')::integer, l.granted_units))
             filter (where l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP')),
           0
         )::integer,
         coalesce(sum(l.granted_units) filter (where l.lot_kind = 'SENIORITY_GRANT'), 0)::integer,
         (
           coalesce(
             sum(l.granted_units)
               filter (where l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP', 'OPENING_CURRENT_YEAR', 'MANUAL_ADJUSTMENT')),
             0
           )::integer
           - coalesce(
               sum(coalesce((l.metadata->>'initial_granted_units')::integer, l.granted_units))
                 filter (where l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP')),
               0
             )::integer
         ),
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

create or replace function public.leave_management_preview_opening_batch(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_leave_year integer,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := coalesce(p_leave_year, pg_catalog.date_part('year', v_today)::integer);
  v_auth jsonb;
  v_policy public.leave_policy_configs%rowtype;
  v_carry_over_expiry date;
  v_rows_fingerprint text;
  v_item jsonb;
  v_idx integer := 0;
  v_target_id_text text;
  v_target_id uuid;
  v_carry_units integer;
  v_open_units integer;
  v_sen_units integer;
  v_note text;
  v_seen_ids uuid[] := array[]::uuid[];
  v_account jsonb;
  v_profile public.leave_employee_profiles%rowtype;
  v_has_profile boolean;
  v_row_errors jsonb;
  v_preview_rows jsonb := '[]'::jsonb;
  v_rows_state jsonb := '[]'::jsonb;
  v_error_count integer := 0;
  v_total_carry integer := 0;
  v_total_open integer := 0;
  v_total_sen integer := 0;
  v_has_carry_expiry_error boolean := false;
  v_current_year_accrued integer := 0;
  v_current_year_granted integer := 0;
  v_current_year_locked integer := 0;
  v_current_year_available integer := 0;
  v_delta_current_year integer := 0;
  v_reconciled_current_year_granted integer := 0;
  v_reconciled_current_year_available integer := 0;
  v_profile_row_version integer := 0;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_manage_config')::boolean, false) then
    raise exception 'LEAVE_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_year < 2020 or v_year > 2100 then
    raise exception 'LEAVE_YEAR_INVALID'
      using errcode = '22023';
  end if;

  if p_rows is null
     or pg_catalog.jsonb_typeof(p_rows) <> 'array'
     or pg_catalog.jsonb_array_length(p_rows) < 1
     or pg_catalog.jsonb_array_length(p_rows) > 300 then
    raise exception 'LEAVE_OPENING_ROWS_INVALID'
      using errcode = '22023';
  end if;

  v_rows_fingerprint := public.leave_management__internal_opening_rows_fingerprint(p_rows);

  select c.*
    into v_policy
    from public.leave_policy_configs c
   where c.config_key = 'default';

  v_carry_over_expiry := public.leave_management__internal_resolve_carry_over_expiry_date(
    v_year,
    v_policy.carry_over_expiry_month,
    v_policy.carry_over_expiry_day
  );

  for v_item in
    select value
      from pg_catalog.jsonb_array_elements(p_rows)
  loop
    v_idx := v_idx + 1;
    v_row_errors := '[]'::jsonb;
    v_target_id := null;
    v_account := null;
    v_has_profile := false;
    v_current_year_accrued := 0;
    v_current_year_granted := 0;
    v_current_year_locked := 0;
    v_current_year_available := 0;
    v_delta_current_year := 0;
    v_reconciled_current_year_granted := 0;
    v_reconciled_current_year_available := 0;
    v_profile_row_version := 0;

    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('ROW_NOT_OBJECT');
      v_carry_units := 0;
      v_open_units := 0;
      v_sen_units := 0;
      v_note := null;
    else
      v_target_id_text := pg_catalog.btrim(coalesce(v_item->>'app_user_id', ''));
      begin
        v_target_id := v_target_id_text::uuid;
      exception
        when others then
          v_target_id := null;
      end;

      begin
        v_carry_units := coalesce((v_item->>'carry_over_units')::integer, 0);
        v_open_units := coalesce((v_item->>'opening_current_year_units')::integer, 0);
        v_sen_units := coalesce((v_item->>'seniority_units')::integer, 0);
      exception
        when others then
          v_carry_units := -1;
          v_open_units := -1;
          v_sen_units := -1;
      end;

      v_note := nullif(pg_catalog.btrim(coalesce(v_item->>'note', '')), '');
      v_delta_current_year := greatest(coalesce(v_open_units, 0), 0);
      v_reconciled_current_year_granted := greatest(coalesce(v_open_units, 0), 0);
      v_reconciled_current_year_available := greatest(coalesce(v_open_units, 0), 0);

      if v_target_id is null then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('INVALID_APP_USER_ID');
      else
        if v_target_id = any(v_seen_ids) then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('DUPLICATE_APP_USER_IN_BATCH');
        else
          v_seen_ids := pg_catalog.array_append(v_seen_ids, v_target_id);
        end if;

        v_account := public.leave_management__internal_account_summary(v_target_id);
        if v_account is null then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('APP_USER_NOT_FOUND');
        end if;

        select p.*
          into v_profile
          from public.leave_employee_profiles p
         where p.app_user_id = v_target_id;
        v_has_profile := found;

        if v_has_profile and v_profile.is_shared_non_employee then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('SHARED_ACCOUNT_NOT_ELIGIBLE');
        elsif v_account is not null and (not v_has_profile or v_profile.employment_status <> 'OFFICIAL') then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('EMPLOYEE_NOT_OFFICIAL');
        elsif v_account is not null and v_has_profile and v_profile.employment_status = 'OFFICIAL' then
          perform public.leave_management__internal_lock_employee(v_target_id);
          perform public.leave_management__internal_sync_employee_accruals(v_target_id, v_today);

          select p.*
            into v_profile
            from public.leave_employee_profiles p
           where p.app_user_id = v_target_id;

          v_profile_row_version := coalesce(v_profile.row_version, 1);

          select
            coalesce(
              sum(coalesce((l.metadata->>'initial_granted_units')::integer, l.granted_units))
                filter (where l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP')),
              0
            )::integer,
            coalesce(sum(l.granted_units), 0)::integer,
            coalesce(sum(l.reserved_units + l.consumed_units + l.expired_units), 0)::integer,
            coalesce(sum(greatest(l.granted_units - l.reserved_units - l.consumed_units - l.expired_units, 0)), 0)::integer
          into
            v_current_year_accrued,
            v_current_year_granted,
            v_current_year_locked,
            v_current_year_available
          from public.leave_lots l
          where l.app_user_id = v_target_id
            and l.leave_year = v_year
            and l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP', 'OPENING_CURRENT_YEAR', 'MANUAL_ADJUSTMENT');

          v_delta_current_year := greatest(coalesce(v_open_units, 0), 0) - v_current_year_granted;
          v_reconciled_current_year_granted := greatest(coalesce(v_open_units, 0), 0);
          v_reconciled_current_year_available := greatest(
            greatest(coalesce(v_open_units, 0), 0) - v_current_year_locked,
            0
          );

          if v_open_units >= 0 and v_open_units < v_current_year_locked then
            v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('OPENING_TARGET_BELOW_LOCKED_BALANCE');
          end if;
        end if;
      end if;

      if v_carry_units < 0 or v_carry_units > 120
         or v_open_units < 0 or v_open_units > 120
         or v_sen_units < 0 or v_sen_units > 60 then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('UNITS_OUT_OF_RANGE');
      elsif (v_carry_units + v_open_units + v_sen_units) <= 0 and v_delta_current_year = 0 then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('ZERO_UNITS_ROW');
      end if;

      if v_carry_units > 0 and v_carry_over_expiry is null then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED');
        v_has_carry_expiry_error := true;
      end if;

      if v_target_id is not null and v_carry_units > 0 then
        if exists (
          select 1
            from public.leave_lots l
           where l.app_user_id = v_target_id
             and l.leave_year = v_year
             and l.lot_kind = 'CARRY_OVER'
        ) then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('CARRY_OVER_LOT_ALREADY_EXISTS');
        end if;
      end if;

      if v_target_id is not null and v_sen_units > 0 then
        if exists (
          select 1
            from public.leave_lots l
           where l.app_user_id = v_target_id
             and l.leave_year = v_year
             and l.lot_kind = 'SENIORITY_GRANT'
        ) then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('SENIORITY_LOT_ALREADY_EXISTS');
        end if;
      end if;
    end if;

    if pg_catalog.jsonb_array_length(v_row_errors) > 0 then
      v_error_count := v_error_count + 1;
    else
      v_total_carry := v_total_carry + v_carry_units;
      v_total_open := v_total_open + v_open_units;
      v_total_sen := v_total_sen + v_sen_units;
    end if;

    v_rows_state := v_rows_state || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'row_index', v_idx,
        'app_user_id', v_target_id,
        'employment_status', case when v_has_profile then v_profile.employment_status else null end,
        'profile_row_version', v_profile_row_version,
        'current_year_accrued_units', v_current_year_accrued,
        'current_year_granted_units', v_current_year_granted,
        'current_year_locked_units', v_current_year_locked,
        'current_year_available_units', v_current_year_available,
        'delta_current_year_units', v_delta_current_year
      )
    );

    v_preview_rows := v_preview_rows || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'row_index', v_idx,
        'app_user_id', v_target_id,
        'account', v_account,
        'as_of_date', v_today,
        'carry_over_units', greatest(coalesce(v_carry_units, 0), 0),
        'opening_current_year_units', greatest(coalesce(v_open_units, 0), 0),
        'target_current_year_units', greatest(coalesce(v_open_units, 0), 0),
        'current_year_accrued_units', v_current_year_accrued,
        'current_year_granted_units', v_current_year_granted,
        'current_year_locked_units', v_current_year_locked,
        'current_year_available_units', v_current_year_available,
        'delta_current_year_units', v_delta_current_year,
        'reconciled_current_year_granted_units', v_reconciled_current_year_granted,
        'reconciled_current_year_available_units', v_reconciled_current_year_available,
        'profile_row_version', v_profile_row_version,
        'seniority_units', greatest(coalesce(v_sen_units, 0), 0),
        'note', v_note,
        'valid', (pg_catalog.jsonb_array_length(v_row_errors) = 0),
        'errors', v_row_errors
      )
    );
  end loop;

  if v_error_count = 0 and v_idx > 0 then
    insert into public.leave_opening_preview_snapshots (
      actor_app_user_id,
      leave_year,
      rows_fingerprint,
      as_of_date,
      carry_over_expires_after_date,
      rows_state,
      created_at,
      consumed_at
    )
    values (
      p_actor_app_user_id,
      v_year,
      v_rows_fingerprint,
      v_today,
      v_carry_over_expiry,
      v_rows_state,
      pg_catalog.timezone('utc', pg_catalog.now()),
      null
    )
    on conflict (actor_app_user_id, leave_year, rows_fingerprint) do update
      set as_of_date = excluded.as_of_date,
          carry_over_expires_after_date = excluded.carry_over_expires_after_date,
          rows_state = excluded.rows_state,
          created_at = excluded.created_at,
          consumed_at = null;
  end if;

  return pg_catalog.jsonb_build_object(
    'leave_year', v_year,
    'as_of_date', v_today,
    'carry_over_expires_after_date', v_carry_over_expiry,
    'valid', (v_error_count = 0),
    'has_carry_over_expiry_error', v_has_carry_expiry_error,
    'row_count', v_idx,
    'error_row_count', v_error_count,
    'total_carry_over_units', v_total_carry,
    'total_opening_current_year_units', v_total_open,
    'total_seniority_units', v_total_sen,
    'rows_state', v_rows_state,
    'rows', v_preview_rows
  );
end;
$function$;

create or replace function public.leave_management_apply_opening_batch(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_leave_year integer,
  p_rows jsonb,
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
  v_year integer := coalesce(p_leave_year, pg_catalog.date_part('year', v_today)::integer);
  v_auth jsonb;
  v_reason text;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_rows_fingerprint text;
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_prev_snapshot public.leave_opening_preview_snapshots%rowtype;
  v_has_prev_snapshot boolean := false;
  v_preview jsonb;
  v_lock_id uuid;
  v_batch public.leave_opening_batches%rowtype;
  v_carry_expiry date;
  v_row jsonb;
  v_input_row jsonb;
  v_target_id uuid;
  v_carry_units integer;
  v_open_units integer;
  v_sen_units integer;
  v_delta_current_year integer;
  v_current_year_accrued integer;
  v_current_year_granted integer;
  v_current_year_locked integer;
  v_remaining_reduction integer;
  v_remaining_addition integer;
  v_lot record;
  v_lot_unlocked integer;
  v_restore_cap integer;
  v_take integer;
  v_give integer;
  v_lot_id uuid;
  v_applied_rows jsonb := '[]'::jsonb;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_manage_config')::boolean, false) then
    raise exception 'LEAVE_ADMIN_FORBIDDEN'
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

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'APPLY_OPENING_BATCH'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_rows is not null and pg_catalog.jsonb_typeof(p_rows) = 'array' then
    for v_lock_id in
      select distinct (elem->>'app_user_id')::uuid as uid
        from pg_catalog.jsonb_array_elements(p_rows) as elem
       where pg_catalog.jsonb_typeof(elem) = 'object'
         and coalesce(elem->>'app_user_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       order by uid asc
    loop
      perform public.leave_management__internal_lock_employee(v_lock_id);
    end loop;
  end if;

  v_rows_fingerprint := public.leave_management__internal_opening_rows_fingerprint(p_rows);

  select s.*
    into v_prev_snapshot
    from public.leave_opening_preview_snapshots s
   where s.actor_app_user_id = p_actor_app_user_id
     and s.leave_year = v_year
     and s.rows_fingerprint = v_rows_fingerprint;

  v_has_prev_snapshot := found;

  v_preview := public.leave_management_preview_opening_batch(
    p_actor_auth_subject,
    p_actor_app_user_id,
    v_year,
    p_rows
  );

  if v_has_prev_snapshot then
    if v_prev_snapshot.consumed_at is not null
       or v_prev_snapshot.as_of_date is distinct from (v_preview->>'as_of_date')::date
       or v_prev_snapshot.carry_over_expires_after_date is distinct from nullif(v_preview->>'carry_over_expires_after_date', '')::date
       or v_prev_snapshot.rows_state is distinct from (v_preview->'rows_state') then
      raise exception 'LEAVE_OPENING_PREVIEW_STALE'
        using errcode = '40001';
    end if;
  end if;

  for v_row in
    select value
      from pg_catalog.jsonb_array_elements(v_preview->'rows')
  loop
    v_input_row := p_rows->(((v_row->>'row_index')::integer) - 1);
    if v_input_row is not null and pg_catalog.jsonb_typeof(v_input_row) = 'object' then
      if nullif(pg_catalog.btrim(coalesce(v_input_row->>'expected_as_of_date', '')), '') is not null
         and (v_input_row->>'expected_as_of_date')::date is distinct from (v_row->>'as_of_date')::date then
        raise exception 'LEAVE_OPENING_PREVIEW_STALE'
          using errcode = '40001';
      end if;

      if nullif(pg_catalog.btrim(coalesce(v_input_row->>'expected_current_year_granted_units', '')), '') is not null
         and (v_input_row->>'expected_current_year_granted_units')::integer is distinct from (v_row->>'current_year_granted_units')::integer then
        raise exception 'LEAVE_OPENING_PREVIEW_STALE'
          using errcode = '40001';
      end if;

      if nullif(pg_catalog.btrim(coalesce(v_input_row->>'expected_current_year_locked_units', '')), '') is not null
         and (v_input_row->>'expected_current_year_locked_units')::integer is distinct from (v_row->>'current_year_locked_units')::integer then
        raise exception 'LEAVE_OPENING_PREVIEW_STALE'
          using errcode = '40001';
      end if;

      if nullif(pg_catalog.btrim(coalesce(v_input_row->>'expected_profile_row_version', '')), '') is not null
         and (v_input_row->>'expected_profile_row_version')::integer is distinct from (v_row->>'profile_row_version')::integer then
        raise exception 'LEAVE_OPENING_PREVIEW_STALE'
          using errcode = '40001';
      end if;
    end if;
  end loop;

  if not coalesce((v_preview->>'valid')::boolean, false) then
    if coalesce((v_preview->>'has_carry_over_expiry_error')::boolean, false) then
      raise exception 'LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED'
        using errcode = '22023';
    end if;
    raise exception 'LEAVE_OPENING_BATCH_VALIDATION_FAILED'
      using errcode = '22023';
  end if;

  v_carry_expiry := nullif(v_preview->>'carry_over_expires_after_date', '')::date;

  insert into public.leave_opening_batches (
    leave_year,
    batch_kind,
    row_count,
    total_carry_over_units,
    total_opening_units,
    total_seniority_units,
    reason,
    payload,
    applied_by_app_user_id
  )
  values (
    v_year,
    case when (v_preview->>'row_count')::integer = 1 then 'SINGLE' else 'BULK' end,
    (v_preview->>'row_count')::integer,
    (v_preview->>'total_carry_over_units')::integer,
    (v_preview->>'total_opening_current_year_units')::integer,
    (v_preview->>'total_seniority_units')::integer,
    v_reason,
    v_preview->'rows',
    p_actor_app_user_id
  )
  returning * into v_batch;

  for v_row in
    select value
      from pg_catalog.jsonb_array_elements(v_preview->'rows')
  loop
    v_target_id := (v_row->>'app_user_id')::uuid;
    v_carry_units := (v_row->>'carry_over_units')::integer;
    v_open_units := (v_row->>'opening_current_year_units')::integer;
    v_sen_units := (v_row->>'seniority_units')::integer;
    v_delta_current_year := coalesce((v_row->>'delta_current_year_units')::integer, 0);
    v_current_year_accrued := coalesce((v_row->>'current_year_accrued_units')::integer, 0);
    v_current_year_granted := coalesce((v_row->>'current_year_granted_units')::integer, 0);
    v_current_year_locked := coalesce((v_row->>'current_year_locked_units')::integer, 0);

    if v_carry_units > 0 then
      insert into public.leave_lots (
        app_user_id,
        leave_year,
        lot_kind,
        accrual_month,
        granted_units,
        usable_from_date,
        expires_after_date,
        source_ref,
        opening_batch_id,
        created_by_app_user_id
      )
      values (
        v_target_id,
        v_year,
        'CARRY_OVER',
        null,
        v_carry_units,
        pg_catalog.make_date(v_year, 1, 1),
        v_carry_expiry,
        pg_catalog.format('OPENING_CARRY_OVER:%s:%s', v_year, v_batch.batch_id),
        v_batch.batch_id,
        p_actor_app_user_id
      )
      returning lot_id into v_lot_id;

      insert into public.leave_ledger_entries (
        app_user_id,
        lot_id,
        opening_batch_id,
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
        v_target_id,
        v_lot_id,
        v_batch.batch_id,
        'GRANT_OPENING_CARRY_OVER',
        pg_catalog.make_date(v_year, 1, 1),
        v_carry_units,
        0,
        0,
        0,
        p_actor_app_user_id,
        v_reason,
        pg_catalog.jsonb_build_object(
          'leave_year', v_year,
          'expires_after_date', v_carry_expiry,
          'note', v_row->>'note'
        )
      );
    end if;

    if v_delta_current_year < 0 then
      v_remaining_reduction := -v_delta_current_year;

      for v_lot in
        select l.*
          from public.leave_lots l
         where l.app_user_id = v_target_id
           and l.leave_year = v_year
           and l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP', 'OPENING_CURRENT_YEAR', 'MANUAL_ADJUSTMENT')
           and (l.granted_units - l.reserved_units - l.consumed_units - l.expired_units) > 0
         order by
           case when l.lot_kind in ('OPENING_CURRENT_YEAR', 'MANUAL_ADJUSTMENT') then 0 else 1 end asc,
           l.usable_from_date desc,
           l.accrual_month desc nulls first,
           l.created_at desc,
           l.lot_id desc
         for update
      loop
        exit when v_remaining_reduction <= 0;

        v_lot_unlocked := greatest(v_lot.granted_units - v_lot.reserved_units - v_lot.consumed_units - v_lot.expired_units, 0);
        v_take := least(v_remaining_reduction, v_lot_unlocked);

        if v_take > 0 then
          update public.leave_lots
             set granted_units = granted_units - v_take,
                 metadata = case
                   when lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP') and not (metadata ? 'initial_granted_units')
                     then metadata || pg_catalog.jsonb_build_object('initial_granted_units', granted_units)
                   else metadata
                 end,
                 updated_at = pg_catalog.timezone('utc', pg_catalog.now())
           where lot_id = v_lot.lot_id;

          insert into public.leave_ledger_entries (
            app_user_id,
            lot_id,
            opening_batch_id,
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
            v_target_id,
            v_lot.lot_id,
            v_batch.batch_id,
            'ADJUST_OPENING_CURRENT_YEAR_DECREASE',
            v_today,
            -v_take,
            0,
            0,
            0,
            p_actor_app_user_id,
            v_reason,
            pg_catalog.jsonb_build_object(
              'leave_year', v_year,
              'reconciliation_mode', 'TARGET_BALANCE',
              'as_of_date', v_today,
              'target_current_year_units', v_open_units,
              'previous_current_year_granted_units', v_current_year_granted,
              'current_year_accrued_units', v_current_year_accrued,
              'current_year_locked_units', v_current_year_locked,
              'delta_current_year_units', v_delta_current_year,
              'lot_kind', v_lot.lot_kind,
              'note', v_row->>'note'
            )
          );

          v_remaining_reduction := v_remaining_reduction - v_take;
        end if;
      end loop;

      if v_remaining_reduction > 0 then
        raise exception 'OPENING_TARGET_BELOW_LOCKED_BALANCE'
          using errcode = '22023';
      end if;
    elsif v_delta_current_year > 0 then
      v_remaining_addition := v_delta_current_year;

      for v_lot in
        select l.*
          from public.leave_lots l
         where l.app_user_id = v_target_id
           and l.leave_year = v_year
           and l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP')
           and coalesce((l.metadata->>'initial_granted_units')::integer, l.granted_units) > l.granted_units
         order by
           l.usable_from_date asc,
           l.accrual_month asc nulls last,
           l.created_at asc,
           l.lot_id asc
         for update
      loop
        exit when v_remaining_addition <= 0;

        v_restore_cap := greatest(coalesce((v_lot.metadata->>'initial_granted_units')::integer, v_lot.granted_units) - v_lot.granted_units, 0);
        v_give := least(v_remaining_addition, v_restore_cap);

        if v_give > 0 then
          update public.leave_lots
             set granted_units = granted_units + v_give,
                 updated_at = pg_catalog.timezone('utc', pg_catalog.now())
           where lot_id = v_lot.lot_id;

          insert into public.leave_ledger_entries (
            app_user_id,
            lot_id,
            opening_batch_id,
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
            v_target_id,
            v_lot.lot_id,
            v_batch.batch_id,
            'ADJUST_OPENING_CURRENT_YEAR_INCREASE',
            v_today,
            v_give,
            0,
            0,
            0,
            p_actor_app_user_id,
            v_reason,
            pg_catalog.jsonb_build_object(
              'leave_year', v_year,
              'reconciliation_mode', 'TARGET_BALANCE',
              'as_of_date', v_today,
              'target_current_year_units', v_open_units,
              'previous_current_year_granted_units', v_current_year_granted,
              'current_year_accrued_units', v_current_year_accrued,
              'current_year_locked_units', v_current_year_locked,
              'delta_current_year_units', v_delta_current_year,
              'lot_kind', v_lot.lot_kind,
              'note', v_row->>'note'
            )
          );

          v_remaining_addition := v_remaining_addition - v_give;
        end if;
      end loop;

      if v_remaining_addition > 0 then
        v_lot_id := null;
        select l.lot_id
          into v_lot_id
          from public.leave_lots l
         where l.app_user_id = v_target_id
           and l.leave_year = v_year
           and l.lot_kind = 'OPENING_CURRENT_YEAR'
         order by l.created_at desc, l.lot_id desc
         limit 1
         for update;

        if v_lot_id is not null then
          update public.leave_lots
             set granted_units = granted_units + v_remaining_addition,
                 opening_batch_id = v_batch.batch_id,
                 updated_at = pg_catalog.timezone('utc', pg_catalog.now())
           where lot_id = v_lot_id;

          insert into public.leave_ledger_entries (
            app_user_id,
            lot_id,
            opening_batch_id,
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
            v_target_id,
            v_lot_id,
            v_batch.batch_id,
            'ADJUST_OPENING_CURRENT_YEAR_INCREASE',
            v_today,
            v_remaining_addition,
            0,
            0,
            0,
            p_actor_app_user_id,
            v_reason,
            pg_catalog.jsonb_build_object(
              'leave_year', v_year,
              'reconciliation_mode', 'TARGET_BALANCE',
              'as_of_date', v_today,
              'target_current_year_units', v_open_units,
              'previous_current_year_granted_units', v_current_year_granted,
              'current_year_accrued_units', v_current_year_accrued,
              'current_year_locked_units', v_current_year_locked,
              'delta_current_year_units', v_delta_current_year,
              'note', v_row->>'note'
            )
          );
        else
          insert into public.leave_lots (
            app_user_id,
            leave_year,
            lot_kind,
            accrual_month,
            granted_units,
            usable_from_date,
            expires_after_date,
            source_ref,
            opening_batch_id,
            created_by_app_user_id,
            metadata
          )
          values (
            v_target_id,
            v_year,
            'OPENING_CURRENT_YEAR',
            null,
            v_remaining_addition,
            pg_catalog.make_date(v_year, 1, 1),
            pg_catalog.make_date(v_year, 12, 31),
            pg_catalog.format('OPENING_CURRENT_YEAR:%s:%s', v_year, v_batch.batch_id),
            v_batch.batch_id,
            p_actor_app_user_id,
            pg_catalog.jsonb_build_object('reconciliation_mode', 'TARGET_BALANCE')
          )
          returning lot_id into v_lot_id;

          insert into public.leave_ledger_entries (
            app_user_id,
            lot_id,
            opening_batch_id,
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
            v_target_id,
            v_lot_id,
            v_batch.batch_id,
            'GRANT_OPENING_CURRENT_YEAR',
            v_today,
            v_remaining_addition,
            0,
            0,
            0,
            p_actor_app_user_id,
            v_reason,
            pg_catalog.jsonb_build_object(
              'leave_year', v_year,
              'reconciliation_mode', 'TARGET_BALANCE',
              'as_of_date', v_today,
              'target_current_year_units', v_open_units,
              'previous_current_year_granted_units', v_current_year_granted,
              'current_year_accrued_units', v_current_year_accrued,
              'current_year_locked_units', v_current_year_locked,
              'delta_current_year_units', v_delta_current_year,
              'note', v_row->>'note'
            )
          );
        end if;
      end if;
    elsif v_open_units > 0 then
      v_lot_id := null;
      select l.lot_id
        into v_lot_id
        from public.leave_lots l
       where l.app_user_id = v_target_id
         and l.leave_year = v_year
         and l.lot_kind in ('OPENING_CURRENT_YEAR', 'MONTHLY_ACCRUAL', 'PROBATION_CATCHUP', 'MANUAL_ADJUSTMENT')
       order by l.usable_from_date desc, l.created_at desc, l.lot_id desc
       limit 1;

      insert into public.leave_ledger_entries (
        app_user_id,
        lot_id,
        opening_batch_id,
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
        v_target_id,
        v_lot_id,
        v_batch.batch_id,
        'GRANT_OPENING_CURRENT_YEAR',
        v_today,
        0,
        0,
        0,
        0,
        p_actor_app_user_id,
        v_reason,
        pg_catalog.jsonb_build_object(
          'leave_year', v_year,
          'reconciliation_mode', 'TARGET_BALANCE',
          'as_of_date', v_today,
          'target_current_year_units', v_open_units,
          'previous_current_year_granted_units', v_current_year_granted,
          'current_year_accrued_units', v_current_year_accrued,
          'current_year_locked_units', v_current_year_locked,
          'delta_current_year_units', 0,
          'note', v_row->>'note'
        )
      );
    end if;

    if v_sen_units > 0 then
      if exists (
        select 1
          from public.leave_lots l
         where l.app_user_id = v_target_id
           and l.leave_year = v_year
           and l.lot_kind = 'SENIORITY_GRANT'
      ) then
        raise exception 'SENIORITY_LOT_ALREADY_EXISTS'
          using errcode = '22023';
      end if;

      insert into public.leave_lots (
        app_user_id,
        leave_year,
        lot_kind,
        accrual_month,
        granted_units,
        usable_from_date,
        expires_after_date,
        source_ref,
        opening_batch_id,
        created_by_app_user_id
      )
      values (
        v_target_id,
        v_year,
        'SENIORITY_GRANT',
        null,
        v_sen_units,
        pg_catalog.make_date(v_year, 1, 1),
        pg_catalog.make_date(v_year, 12, 31),
        pg_catalog.format('OPENING_SENIORITY:%s:%s', v_year, v_batch.batch_id),
        v_batch.batch_id,
        p_actor_app_user_id
      )
      returning lot_id into v_lot_id;

      insert into public.leave_ledger_entries (
        app_user_id,
        lot_id,
        opening_batch_id,
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
        v_target_id,
        v_lot_id,
        v_batch.batch_id,
        'GRANT_SENIORITY',
        pg_catalog.make_date(v_year, 1, 1),
        v_sen_units,
        0,
        0,
        0,
        p_actor_app_user_id,
        v_reason,
        pg_catalog.jsonb_build_object(
          'leave_year', v_year,
          'note', v_row->>'note'
        )
      );
    end if;

    perform public.leave_management__internal_sync_employee_accruals(v_target_id, v_today);

    update public.leave_employee_profiles
       set row_version = row_version + 1,
           updated_by_app_user_id = p_actor_app_user_id,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now())
     where app_user_id = v_target_id;

    v_applied_rows := v_applied_rows || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'app_user_id', v_target_id,
        'as_of_date', v_today,
        'carry_over_units', v_carry_units,
        'opening_current_year_units', v_open_units,
        'target_current_year_units', v_open_units,
        'previous_current_year_granted_units', v_current_year_granted,
        'current_year_accrued_units', v_current_year_accrued,
        'current_year_locked_units', v_current_year_locked,
        'delta_current_year_units', v_delta_current_year,
        'seniority_units', v_sen_units,
        'balance', public.leave_management__internal_compute_balance_summary(v_target_id, v_year, v_today)
      )
    );
  end loop;

  update public.leave_opening_preview_snapshots
     set consumed_at = pg_catalog.timezone('utc', pg_catalog.now())
   where actor_app_user_id = p_actor_app_user_id
     and leave_year = v_year
     and rows_fingerprint = v_rows_fingerprint;

  insert into public.leave_audit_events (
    event_type,
    actor_app_user_id,
    opening_batch_id,
    reason,
    payload
  )
  values (
    'OPENING_BATCH_APPLIED',
    p_actor_app_user_id,
    v_batch.batch_id,
    v_reason,
    pg_catalog.jsonb_build_object(
      'leave_year', v_year,
      'as_of_date', v_today,
      'batch_kind', v_batch.batch_kind,
      'row_count', v_batch.row_count,
      'total_carry_over_units', v_batch.total_carry_over_units,
      'total_opening_units', v_batch.total_opening_units,
      'total_seniority_units', v_batch.total_seniority_units
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'batch_id', v_batch.batch_id,
    'applied_row_count', v_batch.row_count,
    'as_of_date', v_today,
    'batch', pg_catalog.jsonb_build_object(
      'batch_id', v_batch.batch_id,
      'leave_year', v_batch.leave_year,
      'batch_kind', v_batch.batch_kind,
      'row_count', v_batch.row_count,
      'total_carry_over_units', v_batch.total_carry_over_units,
      'total_opening_units', v_batch.total_opening_units,
      'total_seniority_units', v_batch.total_seniority_units,
      'reason', v_batch.reason,
      'applied_at', v_batch.applied_at
    ),
    'applied_rows', v_applied_rows
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'APPLY_OPENING_BATCH',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

revoke all on function
  public.leave_management__internal_opening_rows_fingerprint(jsonb),
  public.leave_management__internal_compute_balance_summary(uuid, integer, date)
from public, anon, authenticated, service_role;

revoke all on function
  public.leave_management_preview_opening_batch(uuid, uuid, integer, jsonb),
  public.leave_management_apply_opening_batch(uuid, uuid, integer, jsonb, text, text, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.leave_management_preview_opening_batch(uuid, uuid, integer, jsonb),
  public.leave_management_apply_opening_batch(uuid, uuid, integer, jsonb, text, text, text)
to service_role;

commit;
