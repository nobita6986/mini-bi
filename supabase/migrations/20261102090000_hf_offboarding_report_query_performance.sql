-- =============================================================================
-- Hotfix: Sustainable Query Performance for Workforce Offboarding Report
-- ("Báo cáo NLĐ nghỉ việc" — GET /api/workforce/offboarding)
--
-- Root causes addressed without raising statement_timeout or changing contracts:
--   1. Replaces per-entry and per-person correlated subqueries with a single
--      set-based pipeline (`direct_entry__internal_offboarding_candidates`):
--        - Resolves `direct_entry_authorization_date()` once.
--        - Filters active `SUBMITTED` entries with canonical national ID once
--          without carrying full `worker_details` JSONB through intermediate CTEs.
--        - Computes non-superseded employment status events once via hash anti-join.
--        - Determines per-entry current status (`DISTINCT ON`) and latest OFF
--          effective date (`MAX`) set-based.
--        - Aggregates per-person eligibility (`not bool_or(status = 'ON')` and
--          `max(last_valid_off_date) <= auth_date - 3`), representative entry,
--          team scope filtering, snapshot entry/event, and MD5 signature
--          set-based without correlated subqueries.
--   2. Eliminates double execution in `direct_entry_offboarding_report`:
--      Materializes the unsuppressed candidate set once in a single SQL query
--      to compute `total` and slice the requested `LIMIT / OFFSET` page before
--      joining `direct_entries`, `direct_entry_projects`, and `recruiters` to
--      enrich display fields (`display_name`, gated `phone`, project/recruiter
--      names) for at most `page_size` rows.
--   3. Shares `direct_entry__internal_offboarding_candidates` with
--      `direct_entry__internal_offboarding_rows` (used by export) and
--      `direct_entry_offboarding_hide_snapshot`.
--   4. Index evaluation (`EXPLAIN (ANALYZE, BUFFERS)` + `pg_stat_user_indexes`):
--      Existing indexes (`direct_entries_national_id_exact_idx`,
--      `direct_entries_pkey`, `direct_entry_submissions_pkey`,
--      `direct_entry_employment_status_events_pkey`,
--      `direct_entry_employment_status_events_supersedes_event_id_key`,
--      `direct_entry_offboarding_suppressions_snapshot_idx`,
--      `direct_entry_offboarding_suppressions_actor_idempotency_key`,
--      `recruiter_team_memberships_one_current_per_recruiter_idx`) already
--      cover every scan/join in the set-based plan; no redundant index is added.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Internal set-based candidate & suppression helper (revoked from all client
--    and service roles; shared by paginated list, full export, and hide action)
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry__internal_offboarding_candidates(
  p_scope text,
  p_team_id uuid,
  p_auth_date date
)
returns table (
  entry_id uuid,
  employee_code text,
  project_id text,
  recruiter_id uuid,
  off_effective_date date,
  days_since_off integer,
  snapshot_entry_id uuid,
  snapshot_status_event_id uuid,
  snapshot_signature text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  with valid_entries as materialized (
    select
      e.entry_id,
      e.employee_code,
      e.first_work_date,
      e.created_at as entry_created_at,
      s.submitted_at,
      e.project_id,
      e.recruiter_id,
      nid.national_id_norm
    from public.direct_entries e
    join public.direct_entry_submissions s
      on s.submission_id = e.submission_id
    cross join lateral (
      select
        case
          when (e.worker_details->'national_id'->>'value') ~ '^([0-9]{9}|[0-9]{12})$'
            then e.worker_details->'national_id'->>'value'
          else
            case
              when public.direct_entry_is_canonical_national_id(
                public.direct_entry_canonical_national_id(e.worker_details->'national_id'->>'value')
              )
              then public.direct_entry_canonical_national_id(e.worker_details->'national_id'->>'value')
              else null
            end
        end as national_id_norm
    ) nid
    where s.state = 'SUBMITTED'
      and e.deleted_at is null
      and e.voided_at is null
      and e.worker_details->'national_id'->>'state' = 'provided'
      and nid.national_id_norm is not null
  ),
  non_superseded_events as materialized (
    select
      ev.event_id,
      ev.entry_id,
      ev.status,
      ev.effective_date,
      ev.version,
      ev.applied_at
    from public.direct_entry_employment_status_events ev
    where not exists (
      select 1
      from public.direct_entry_employment_status_events r
      where r.supersedes_event_id = ev.event_id
    )
  ),
  latest_entry_status as (
    select distinct on (nse.entry_id)
      nse.entry_id,
      nse.status as latest_valid_status
    from non_superseded_events nse
    where nse.effective_date <= p_auth_date
    order by nse.entry_id, nse.effective_date desc, nse.version desc, nse.event_id desc
  ),
  entry_off_dates as (
    select
      nse.entry_id,
      max(nse.effective_date) as last_valid_off_date
    from non_superseded_events nse
    where nse.effective_date <= p_auth_date
      and nse.status = 'OFF'
    group by nse.entry_id
  ),
  ep as (
    select
      ve.entry_id,
      ve.employee_code,
      ve.first_work_date,
      ve.entry_created_at,
      ve.submitted_at,
      ve.project_id,
      ve.recruiter_id,
      ve.national_id_norm,
      les.latest_valid_status,
      eod.last_valid_off_date
    from valid_entries ve
    left join latest_entry_status les
      on les.entry_id = ve.entry_id
    left join entry_off_dates eod
      on eod.entry_id = ve.entry_id
  ),
  eligible as materialized (
    select
      ep.national_id_norm,
      max(ep.last_valid_off_date) as last_off_date,
      (pg_catalog.array_agg(
        ep.entry_id
        order by ep.last_valid_off_date desc nulls last, ep.first_work_date desc, ep.entry_id desc
      ))[1] as rep_entry_id,
      (pg_catalog.array_agg(
        ep.employee_code
        order by ep.last_valid_off_date desc nulls last, ep.first_work_date desc, ep.entry_id desc
      ))[1] as employee_code,
      (pg_catalog.array_agg(
        ep.project_id
        order by ep.last_valid_off_date desc nulls last, ep.first_work_date desc, ep.entry_id desc
      ))[1] as project_id,
      (pg_catalog.array_agg(
        ep.recruiter_id
        order by ep.last_valid_off_date desc nulls last, ep.first_work_date desc, ep.entry_id desc
      ))[1] as recruiter_id,
      (pg_catalog.array_agg(
        ep.entry_id
        order by ep.first_work_date desc, ep.submitted_at desc, ep.entry_created_at desc, ep.entry_id desc
      ))[1] as snapshot_entry_id,
      pg_catalog.string_agg(ep.entry_id::text, ',' order by ep.entry_id) as entries_sig
    from ep
    group by ep.national_id_norm
    having not coalesce(bool_or(ep.latest_valid_status = 'ON'), false)
       and max(ep.last_valid_off_date) is not null
       and max(ep.last_valid_off_date) <= p_auth_date - 3
  ),
  scoped_eligible as materialized (
    select
      el.national_id_norm,
      el.rep_entry_id as entry_id,
      el.employee_code,
      el.project_id,
      el.recruiter_id,
      el.last_off_date,
      el.snapshot_entry_id,
      el.entries_sig
    from eligible el
    where p_scope = 'all'
       or exists (
         select 1
         from public.recruiter_team_memberships m
         where m.recruiter_id = el.recruiter_id
           and m.team_id = p_team_id
           and m.is_current
       )
  ),
  person_event_agg as materialized (
    select
      ve.national_id_norm,
      (pg_catalog.array_agg(
        nse.event_id
        order by
          (nse.effective_date <= p_auth_date) desc,
          nse.effective_date desc,
          nse.version desc,
          nse.applied_at desc,
          nse.event_id desc
      ))[1] as snapshot_status_event_id,
      pg_catalog.string_agg(nse.event_id::text, ',' order by nse.event_id) as events_sig
    from valid_entries ve
    join non_superseded_events nse
      on nse.entry_id = ve.entry_id
    group by ve.national_id_norm
  ),
  person_snapshot as (
    select
      se.entry_id,
      se.employee_code,
      se.project_id,
      se.recruiter_id,
      se.last_off_date as off_effective_date,
      (p_auth_date - se.last_off_date)::integer as days_since_off,
      se.snapshot_entry_id,
      peva.snapshot_status_event_id,
      pg_catalog.md5(
        'entries:' || coalesce(se.entries_sig, '') ||
        '|events:' || coalesce(peva.events_sig, '')
      ) as snapshot_signature
    from scoped_eligible se
    join person_event_agg peva
      on peva.national_id_norm = se.national_id_norm
  )
  select
    ps.entry_id,
    ps.employee_code,
    ps.project_id,
    ps.recruiter_id,
    ps.off_effective_date,
    ps.days_since_off,
    ps.snapshot_entry_id,
    ps.snapshot_status_event_id,
    ps.snapshot_signature
  from person_snapshot ps
  where ps.snapshot_entry_id is not null
    and ps.snapshot_status_event_id is not null
    and not exists (
      select 1
      from public.direct_entry_offboarding_suppressions sup
      where sup.snapshot_entry_id = ps.snapshot_entry_id
        and sup.snapshot_status_event_id = ps.snapshot_status_event_id
        and sup.snapshot_signature = ps.snapshot_signature
    );
$function$;

comment on function public.direct_entry__internal_offboarding_candidates(text, uuid, date) is
  'Internal set-based offboarding candidate & suppression pipeline shared by list, export, and hide RPCs.';

-- -----------------------------------------------------------------------------
-- 3. Replace `direct_entry__internal_offboarding_rows` to reuse the shared
--    set-based candidate pipeline (`direct_entry_offboarding_rows` and
--    `direct_entry_offboarding_report_export` delegate here)
-- -----------------------------------------------------------------------------
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
declare
  v_auth_date date := public.direct_entry_authorization_date();
begin
  return query
  select
    c.employee_code,
    de.worker_details->>'display_name' as display_name,
    c.project_id,
    p.display_name as project_display,
    c.recruiter_id,
    r.display_name as recruiter_display,
    c.off_effective_date,
    c.days_since_off,
    case
      when p_can_phone and de.worker_details->'phone'->>'state' = 'provided'
        then de.worker_details->'phone'->>'value'
      else null
    end as phone,
    c.snapshot_entry_id,
    c.snapshot_status_event_id,
    c.snapshot_signature
  from public.direct_entry__internal_offboarding_candidates(p_scope, p_team_id, v_auth_date) c
  join public.direct_entries de
    on de.entry_id = c.entry_id
  join public.direct_entry_projects p
    on p.project_id = c.project_id
  join public.recruiters r
    on r.recruiter_id = c.recruiter_id;
end;
$function$;

comment on function public.direct_entry__internal_offboarding_rows(uuid, uuid, text, uuid, boolean) is
  'Internal offboarding rows with current snapshot references and active suppression filtering; never emits raw or derived CCCD. Revoked from every runtime role.';

-- -----------------------------------------------------------------------------
-- 4. Replace `direct_entry_offboarding_report` (paginated list):
--    Builds the unsuppressed candidate set ONCE, computes `total`, slices
--    the current page (`LIMIT / OFFSET`), and enriches only the page rows.
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
  v_can_hide boolean;
  v_auth_date date;
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
  v_auth_date := public.direct_entry_authorization_date();

  -- Single candidate pass shared with direct_entry_offboarding_rows:
  -- materialize candidates once, count total, paginate, and enrich only the page slice.
  with candidates as materialized (
    select
      c.entry_id,
      c.employee_code,
      c.project_id,
      c.recruiter_id,
      c.off_effective_date,
      c.days_since_off,
      c.snapshot_entry_id,
      c.snapshot_status_event_id,
      c.snapshot_signature
    from public.direct_entry__internal_offboarding_candidates(v_scope, v_team_id, v_auth_date) c
  ),
  counted as (
    select count(*)::int as total
    from candidates
  ),
  page_candidates as (
    select
      c.entry_id,
      c.employee_code,
      c.project_id,
      c.recruiter_id,
      c.off_effective_date,
      c.days_since_off,
      c.snapshot_entry_id,
      c.snapshot_status_event_id
    from candidates c
    order by c.off_effective_date asc, c.employee_code asc, c.entry_id asc
    limit v_page_size
    offset v_offset
  ),
  enriched_page as (
    select
      pc.entry_id,
      pc.employee_code,
      de.worker_details->>'display_name' as display_name,
      pc.project_id,
      p.display_name as project_display,
      pc.recruiter_id,
      r.display_name as recruiter_display,
      pc.off_effective_date,
      pc.days_since_off,
      case
        when v_can_phone and de.worker_details->'phone'->>'state' = 'provided'
          then de.worker_details->'phone'->>'value'
        else null
      end as phone,
      pc.snapshot_entry_id,
      pc.snapshot_status_event_id
    from page_candidates pc
    join public.direct_entries de
      on de.entry_id = pc.entry_id
    join public.direct_entry_projects p
      on p.project_id = pc.project_id
    join public.recruiters r
      on r.recruiter_id = pc.recruiter_id
  ),
  aggregated_items as (
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'employee_code', ep.employee_code,
            'display_name', ep.display_name,
            'project_id', ep.project_id,
            'project_display', ep.project_display,
            'recruiter_id', ep.recruiter_id,
            'recruiter_display', ep.recruiter_display,
            'off_effective_date', pg_catalog.to_char(ep.off_effective_date, 'YYYY-MM-DD'),
            'days_since_off', ep.days_since_off
          )
          || case
               when v_can_phone then jsonb_build_object('phone', ep.phone)
               else '{}'::jsonb
             end
          || case
               when v_can_hide then jsonb_build_object(
                 'snapshot_entry_id', ep.snapshot_entry_id,
                 'snapshot_status_event_id', ep.snapshot_status_event_id
               )
               else '{}'::jsonb
             end
          order by ep.off_effective_date asc, ep.employee_code asc, ep.entry_id asc
        ),
        '[]'::jsonb
      ) as items
    from enriched_page ep
  )
  select
    cnt.total,
    ai.items
  into
    v_total,
    v_items
  from counted cnt
  cross join aggregated_items ai;

  v_has_more := v_offset + v_page_size < v_total;

  return jsonb_build_object(
    'scope', v_scope,
    'authority', v_auth->>'authority',
    'can_export', (v_auth->>'can_export')::boolean,
    'can_hide', v_can_hide,
    'authorization_date', v_auth_date,
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

-- -----------------------------------------------------------------------------
-- 5. Replace `direct_entry_offboarding_hide_snapshot`:
--    Reuses `direct_entry__internal_offboarding_candidates` without enriching
--    display columns.
-- -----------------------------------------------------------------------------
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
  v_national_id text;
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
    into v_national_id
    from public.direct_entries e
    join public.direct_entry_submissions s
      on s.submission_id = e.submission_id
     and s.state = 'SUBMITTED'
   where e.entry_id = p_snapshot_entry_id
     and e.deleted_at is null
     and e.voided_at is null
     and e.worker_details->'national_id'->>'state' = 'provided';

  if v_national_id is null or not public.direct_entry_is_canonical_national_id(v_national_id) then
    raise exception 'WORKFORCE_OFFBOARDING_SNAPSHOT_STALE' using errcode = 'PT409';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('offboarding_person:' || v_national_id, 0)
  );

  select c.snapshot_signature
    into v_signature
    from public.direct_entry__internal_offboarding_candidates(
      'all',
      null,
      public.direct_entry_authorization_date()
    ) c
   where c.snapshot_entry_id = p_snapshot_entry_id
     and c.snapshot_status_event_id = p_snapshot_status_event_id
   limit 1;

  if v_signature is null then
    raise exception 'WORKFORCE_OFFBOARDING_SNAPSHOT_STALE' using errcode = 'PT409';
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
-- 5. Owner alignment & strict RPC ACLs
-- -----------------------------------------------------------------------------
do $$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_proc_owner_oid oid;
  v_sig text;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  foreach v_sig in array array[
    'public.direct_entry__internal_offboarding_candidates(text, uuid, date)',
    'public.direct_entry__internal_offboarding_rows(uuid, uuid, text, uuid, boolean)',
    'public.direct_entry_offboarding_rows(uuid, uuid, text, uuid, boolean)',
    'public.direct_entry_offboarding_report(uuid, uuid, integer, integer)',
    'public.direct_entry_offboarding_report_export(uuid, uuid)',
    'public.direct_entry_offboarding_hide_snapshot(uuid, uuid, uuid, uuid, text, text)'
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
$$;

revoke all on function public.direct_entry__internal_offboarding_candidates(text, uuid, date)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry__internal_offboarding_rows(uuid, uuid, text, uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_offboarding_rows(uuid, uuid, text, uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_offboarding_report(uuid, uuid, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_offboarding_report_export(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_offboarding_hide_snapshot(uuid, uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;

grant execute on function public.direct_entry_offboarding_report(uuid, uuid, integer, integer)
  to service_role;
grant execute on function public.direct_entry_offboarding_report_export(uuid, uuid)
  to service_role;
grant execute on function public.direct_entry_offboarding_hide_snapshot(uuid, uuid, uuid, uuid, text, text)
  to service_role;

do $$
declare
  v_owner name;
begin
  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and p.proname in (
         'direct_entry_offboarding_authority',
         'direct_entry__internal_offboarding_candidates',
         'direct_entry__internal_offboarding_rows',
         'direct_entry_offboarding_rows',
         'direct_entry_offboarding_report',
         'direct_entry_offboarding_report_export',
         'direct_entry_offboarding_hide_snapshot'
       )
  loop
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
      'grant execute on function public.direct_entry_offboarding_authority(uuid, uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry__internal_offboarding_candidates(text, uuid, date) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry__internal_offboarding_rows(uuid, uuid, text, uuid, boolean) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_offboarding_rows(uuid, uuid, text, uuid, boolean) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_offboarding_report(uuid, uuid, integer, integer) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_offboarding_report_export(uuid, uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_offboarding_hide_snapshot(uuid, uuid, uuid, uuid, text, text) to %I',
      v_owner
    );
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Data-free fail-closed install self-check
-- -----------------------------------------------------------------------------
do $$
declare
  v_fn record;
  v_src text;
  v_report_src text;
begin
  for v_fn in
    select
      u.sig,
      u.allow_service_role,
      p.oid,
      p.prosecdef,
      p.proconfig,
      p.proowner,
      p.proacl,
      r.rolsuper,
      r.rolbypassrls
    from (
      values
        ('public.direct_entry_offboarding_authority(uuid, uuid)', false),
        ('public.direct_entry__internal_offboarding_candidates(text, uuid, date)', false),
        ('public.direct_entry__internal_offboarding_rows(uuid, uuid, text, uuid, boolean)', false),
        ('public.direct_entry_offboarding_rows(uuid, uuid, text, uuid, boolean)', false),
        ('public.direct_entry_offboarding_report(uuid, uuid, integer, integer)', true),
        ('public.direct_entry_offboarding_report_export(uuid, uuid)', true),
        ('public.direct_entry_offboarding_hide_snapshot(uuid, uuid, uuid, uuid, text, text)', true)
    ) as u(sig, allow_service_role)
    left join pg_catalog.pg_proc p
      on p.oid = pg_catalog.to_regprocedure(u.sig)
    left join pg_catalog.pg_roles r
      on r.oid = p.proowner
  loop
    if v_fn.oid is null then
      raise exception 'Offboarding performance self-check failed: missing routine %', v_fn.sig
        using errcode = '55000';
    end if;

    if not v_fn.prosecdef then
      raise exception 'Offboarding performance self-check failed: % must be SECURITY DEFINER', v_fn.sig
        using errcode = '55000';
    end if;

    if v_fn.proconfig is null or not ('search_path=pg_catalog, public' = any(v_fn.proconfig)) then
      raise exception 'Offboarding performance self-check failed: % must lock search_path=pg_catalog, public', v_fn.sig
        using errcode = '55000';
    end if;

    if not (coalesce(v_fn.rolsuper, false) or coalesce(v_fn.rolbypassrls, false)) then
      raise exception 'Offboarding performance self-check failed: owner of % must bypass FORCE RLS', v_fn.sig
        using errcode = '55000';
    end if;

    if not pg_catalog.has_function_privilege(v_fn.proowner, v_fn.oid, 'EXECUTE') then
      raise exception 'Offboarding performance self-check failed: owner of % lacks EXECUTE', v_fn.sig
        using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('anon', v_fn.oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_fn.oid, 'EXECUTE')
       or exists (
         select 1
         from pg_catalog.aclexplode(coalesce(v_fn.proacl, pg_catalog.acldefault('f', v_fn.proowner))) a
         where a.grantee = 0
           and a.privilege_type = 'EXECUTE'
       ) then
      raise exception 'Offboarding performance self-check failed: % exposed to anon/authenticated/PUBLIC', v_fn.sig
        using errcode = '55000';
    end if;

    if v_fn.allow_service_role then
      if not pg_catalog.has_function_privilege('service_role', v_fn.oid, 'EXECUTE') then
        raise exception 'Offboarding performance self-check failed: service_role lacks EXECUTE on %', v_fn.sig
          using errcode = '55000';
      end if;
    else
      if pg_catalog.has_function_privilege('service_role', v_fn.oid, 'EXECUTE') then
        raise exception 'Offboarding performance self-check failed: service_role must not have EXECUTE on helper %', v_fn.sig
          using errcode = '55000';
      end if;
    end if;
  end loop;

  select pg_catalog.string_agg(p.prosrc, E'\n')
    into v_src
    from pg_catalog.pg_proc p
   where p.oid in (
     'public.direct_entry__internal_offboarding_candidates(text, uuid, date)'::pg_catalog.regprocedure,
     'public.direct_entry__internal_offboarding_rows(uuid, uuid, text, uuid, boolean)'::pg_catalog.regprocedure,
     'public.direct_entry_offboarding_rows(uuid, uuid, text, uuid, boolean)'::pg_catalog.regprocedure,
     'public.direct_entry_offboarding_report(uuid, uuid, integer, integer)'::pg_catalog.regprocedure,
     'public.direct_entry_offboarding_report_export(uuid, uuid)'::pg_catalog.regprocedure,
     'public.direct_entry_offboarding_hide_snapshot(uuid, uuid, uuid, uuid, text, text)'::pg_catalog.regprocedure
   );

  if pg_catalog.strpos(pg_catalog.lower(coalesce(v_src, '')), 'cccd_last4') > 0
     or pg_catalog.strpos(pg_catalog.lower(coalesce(v_src, '')), pg_catalog.chr(39) || 'cccd' || pg_catalog.chr(39)) > 0 then
    raise exception 'Offboarding performance self-check failed: forbidden CCCD key literal in routine body'
      using errcode = '55000';
  end if;

  select p.prosrc
    into v_report_src
    from pg_catalog.pg_proc p
   where p.oid = 'public.direct_entry_offboarding_report(uuid, uuid, integer, integer)'::pg_catalog.regprocedure;

  if pg_catalog.strpos(coalesce(v_report_src, ''), 'direct_entry__internal_offboarding_rows') > 0 then
    raise exception 'Offboarding performance self-check failed: direct_entry_offboarding_report must not invoke full-row helper'
      using errcode = '55000';
  end if;
end;
$$;

commit;
