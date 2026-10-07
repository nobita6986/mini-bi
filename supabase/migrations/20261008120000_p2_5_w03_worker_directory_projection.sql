-- =============================================================================
-- P2.5-W03 - Worker directory server projection (recruiter / project / all).
--
-- P2.5 section 4.1 read model, no raw table exposure:
--   * recruiter audience  = verified, effective app-user/recruiter link
--     -> direct_entries.recruiter_id (CANONICAL recruiter identity);
--   * project audience    = effective project-manager assignment (W07B/W02
--     predicate, never re-implemented here) -> direct_entries.project_id;
--   * all audience        = an effective all scope grant AND at least one
--     effective reviewer/admin capability: entry_admin (Admin/project
--     administrator) or change_review (Accounting/BoD reviewer, P2.5 section 3).
--     The reporting audience (W05A own/team/all) is a different decision and is
--     never consulted, and no role/email can substitute for the grants;
--   * created_by_user_id  = uploader history only. It never widens an audience and
--     it never grants view of anybody else's rows.
--
-- Pagination, ordering and every filter are enforced in this function (keyset,
-- LIMIT page_size + 1). The browser can neither choose an ordering nor page
-- through rows it is not entitled to, because the audience predicate is part of
-- the same query that produces the page.
--
-- Field-sensitive projection:
--   * the base row carries identity + placement metadata only;
--   * raw PII (national id, address, phone, date of birth) is NOT returned by the
--     directory at all - the existing capability-gated detail read owns that;
--   * payment is returned only with an effective payment_view grant, and the
--     account number is masked exactly like direct_entry_read_projection does.
--
-- allowed_actions is the single authority signal for the row. propose_change stays
-- FALSE with the stable code PROPOSE_PENDING_W04_POLICY: the create/read/withdraw
-- policy of the change-request engine is still W04 scope, so W03 must not advertise
-- a capability the policy lane has not closed yet. is_project_manager is exposed as
-- data (not as an action) so W04/W06 can flip the action without a contract change.
--
-- ACL: both functions are SECURITY DEFINER with a fixed search_path; only
-- direct_entry_list_workers is granted, to service_role, and the audience guard is
-- revoked from every role.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Audience guard: the ONLY place that decides which rows an actor may see.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_worker_directory_audience(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_scope text,
  p_project_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_today date := public.direct_entry_authorization_date();
  v_link_count integer;
  v_recruiter_id uuid;
  v_project_ids jsonb;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if p_scope is null or p_scope not in ('recruited', 'managed', 'all') then
    raise exception 'invalid worker directory scope' using errcode = '22023';
  end if;
  if p_project_id is not null
     and p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'invalid project filter' using errcode = '22023';
  end if;

  if p_scope = 'recruited' then
    -- Canonical recruiter identity only: a verified link that is effective today.
    -- Ambiguous links fail closed instead of guessing an identity.
    select count(*)::int into v_link_count
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_app_user_id
       and l.verified
       and l.valid_from <= v_today
       and (l.valid_to is null or v_today < l.valid_to);
    if v_link_count = 0 then
      raise exception 'worker directory recruiter link required' using errcode = '42501';
    end if;
    if v_link_count > 1 then
      raise exception 'worker directory recruiter link ambiguous' using errcode = '42501';
    end if;

    select l.recruiter_id into v_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiters r
        on r.recruiter_id = l.recruiter_id
       and r.active
     where l.app_user_id = p_app_user_id
       and l.verified
       and l.valid_from <= v_today
       and (l.valid_to is null or v_today < l.valid_to)
     limit 1;
    if v_recruiter_id is null then
      raise exception 'worker directory recruiter unavailable' using errcode = '42501';
    end if;

    return jsonb_build_object(
      'scope', 'recruited',
      'recruiter_ids', jsonb_build_array(v_recruiter_id),
      'project_ids', '[]'::jsonb,
      'view_pii', public.direct_entry_has_capability(p_app_user_id, 'pii_view'),
      'view_payment', public.direct_entry_has_capability(p_app_user_id, 'payment_view')
    );
  end if;

  if p_scope = 'managed' then
    -- Current project manager only: the W07B/W02 effective-interval predicate.
    if not public.direct_entry_actor_has_project_assignment(p_app_user_id) then
      raise exception 'worker directory project assignment required' using errcode = '42501';
    end if;

    select coalesce(jsonb_agg(distinct a.project_id), '[]'::jsonb)
      into v_project_ids
      from public.direct_entry_project_manager_assignments a
      join public.direct_entry_app_user_recruiter_links l
        on l.recruiter_id = a.manager_recruiter_id
       and l.app_user_id = p_app_user_id
       and l.verified
       and l.valid_from <= v_today
       and (l.valid_to is null or v_today < l.valid_to)
     where a.valid_from <= v_today
       and (a.valid_to is null or v_today < a.valid_to);

    if jsonb_array_length(v_project_ids) = 0 then
      raise exception 'worker directory project assignment required' using errcode = '42501';
    end if;
    -- A project the actor does not manage is refused, not silently empty: the
    -- caller asked for a scope it does not hold.
    if p_project_id is not null and not (v_project_ids ? p_project_id) then
      raise exception 'worker directory project is out of scope' using errcode = '42501';
    end if;

    return jsonb_build_object(
      'scope', 'managed',
      'recruiter_ids', '[]'::jsonb,
      'project_ids', v_project_ids,
      'view_pii', public.direct_entry_has_capability(p_app_user_id, 'pii_view'),
      'view_payment', public.direct_entry_has_capability(p_app_user_id, 'payment_view')
    );
  end if;

  -- 'all': the DB-authoritative directory audience. Both conditions are required:
  --   1. an effective all scope grant, and
  --   2. at least one effective reviewer/admin capability - entry_admin (Admin or
  --      project administrator) or change_review (Accounting / BoD reviewer).
  -- A reviewer bundle therefore never has to accept entry_admin just to read the
  -- directory, and a team/own scope, a reporting audience, a role or an email can
  -- never open it, because none of those are capability or scope grants.
  -- Project CRUD/assignment keeps its own stricter guard
  -- (direct_entry_assert_project_admin = entry_admin + all scope).
  if not exists (
    select 1
      from public.direct_entry_scope_grants s
     where s.app_user_id = p_app_user_id
       and s.scope_kind = 'all'
       and s.valid_from <= v_today
       and (s.valid_to is null or v_today < s.valid_to)
  ) then
    raise exception 'worker directory requires all scope' using errcode = '42501';
  end if;
  if not (
    public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
    or public.direct_entry_has_capability(p_app_user_id, 'change_review')
  ) then
    raise exception 'worker directory requires a reviewer or admin capability'
      using errcode = '42501';
  end if;
  return jsonb_build_object(
    'scope', 'all',
    'recruiter_ids', '[]'::jsonb,
    'project_ids', '[]'::jsonb,
    'view_pii', public.direct_entry_has_capability(p_app_user_id, 'pii_view'),
    'view_payment', public.direct_entry_has_capability(p_app_user_id, 'payment_view')
  );
end;
$$;
revoke all on function public.direct_entry_worker_directory_audience(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_worker_directory_audience(uuid, uuid, text, text) is
  'P2.5-W03 internal audience guard for the worker directory: resolves recruited/managed/all from '
  'the verified recruiter link, the effective project-manager assignment, or an effective all scope '
  'grant combined with entry_admin or change_review. Reporting audience, role and email never grant '
  'access. created_by_user_id is never an audience. Revoked from every role.';

-- -----------------------------------------------------------------------------
-- 2. The directory page itself.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_list_workers(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_scope text,
  p_project_id text default null,
  p_recruiter_id uuid default null,
  p_employment_status text default null,
  p_cursor text default null,
  p_page_size integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_audience jsonb;
  v_scope text;
  v_recruiter_ids uuid[];
  v_project_ids text[];
  v_view_pii boolean;
  v_view_payment boolean;
  v_page_size integer;
  v_cursor_stamp text;
  v_cursor_id uuid;
  v_scanned integer;
  v_items jsonb;
  v_next_cursor text;
begin
  v_audience := public.direct_entry_worker_directory_audience(
    p_auth_subject, p_app_user_id, p_scope, p_project_id
  );
  v_scope := v_audience->>'scope';
  v_view_pii := (v_audience->>'view_pii')::boolean;
  v_view_payment := (v_audience->>'view_payment')::boolean;
  v_recruiter_ids := case
    when jsonb_array_length(v_audience->'recruiter_ids') = 0 then null
    else array(select jsonb_array_elements_text(v_audience->'recruiter_ids')::uuid)
  end;
  v_project_ids := case
    when jsonb_array_length(v_audience->'project_ids') = 0 then null
    else array(select jsonb_array_elements_text(v_audience->'project_ids'))
  end;

  v_page_size := coalesce(p_page_size, 25);
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  if p_employment_status is not null
     and p_employment_status not in ('UNCONFIRMED', 'ON', 'OFF') then
    raise exception 'invalid employment status filter' using errcode = '22023';
  end if;
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{8}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    v_cursor_stamp := pg_catalog.split_part(p_cursor, ':', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, ':', 2)::uuid;
  end if;

  with candidates as (
    select e.entry_id,
           e.version,
           e.project_id,
           e.first_work_date,
           e.employee_code,
           e.worker_details,
           e.recruiter_id,
           e.labor_type,
           s.state,
           pr.display_name as project_display,
           rc.display_name as recruiter_display,
           st.status as employment_status,
           pay.state as payment_state,
           pay.account_number,
           pay.bank_id,
           pay.account_holder_name,
           pay.version as payment_version
      from public.direct_entries e
      join public.direct_entry_submissions s
        on s.submission_id = e.submission_id
      join public.direct_entry_projects pr
        on pr.project_id = e.project_id
      join public.recruiters rc
        on rc.recruiter_id = e.recruiter_id
      left join lateral (
        select ev.status
          from public.direct_entry_employment_status_events ev
         where ev.entry_id = e.entry_id
         order by ev.version desc
         limit 1
      ) st on true
      left join public.direct_entry_payments pay
        on pay.entry_id = e.entry_id
     where e.deleted_at is null
       and s.state = 'SUBMITTED'
       and (
         v_scope = 'all'
         or (v_scope = 'recruited' and e.recruiter_id = any(v_recruiter_ids))
         or (v_scope = 'managed' and e.project_id = any(v_project_ids))
       )
       and (p_project_id is null or e.project_id = p_project_id)
       and (p_recruiter_id is null or e.recruiter_id = p_recruiter_id)
       and (p_employment_status is null or st.status = p_employment_status)
       and (
         v_cursor_stamp is null
         or (
              pg_catalog.to_char(e.first_work_date, 'YYYYMMDD'),
              e.entry_id::text
            ) < (v_cursor_stamp, v_cursor_id::text)
       )
  ),
  page as (
    select c.*,
           pg_catalog.to_char(c.first_work_date, 'YYYYMMDD') || ':' || c.entry_id::text as cursor
      from candidates c
     order by c.first_work_date desc, c.entry_id desc
     limit v_page_size + 1
  ),
  trimmed as (
    select * from page order by first_work_date desc, entry_id desc limit v_page_size
  )
  select
    (select count(*)::int from page),
    (
      select coalesce(jsonb_agg(jsonb_build_object(
               'entry_id', t.entry_id,
               'entry_version', t.version,
               'submission_state', t.state,
               'employee_code', t.employee_code,
               'display_name', t.worker_details->>'display_name',
               'project_id', t.project_id,
               'project_display', t.project_display,
               'first_work_date', pg_catalog.to_char(t.first_work_date, 'YYYY-MM-DD'),
               'labor_type', t.labor_type,
               'employment_status', t.employment_status,
               'recruiter_id', t.recruiter_id,
               'recruiter_display', t.recruiter_display,
               'payment', case
                 when v_view_payment and t.payment_state is not null then jsonb_build_object(
                   'state', t.payment_state,
                   'account_number', case when t.account_number is null then null
                     else repeat('•', greatest(length(t.account_number) - 4, 0))
                          || right(t.account_number, 4) end,
                   'bank_id', t.bank_id,
                   'account_holder_name', t.account_holder_name,
                   'version', t.payment_version
                 )
                 else null
               end,
               'pending_request', case when pr.request_id is null then null else jsonb_build_object(
                 'request_id', pr.request_id,
                 'state', 'PENDING',
                 'version', pr.version
               ) end,
               'last_decision', case when ld.state is null then null else jsonb_build_object(
                 'state', ld.state,
                 'decided_at', pg_catalog.to_char(ld.decided_at at time zone 'UTC', 'YYYY-MM-DD')
                   || 'T' || pg_catalog.to_char(ld.decided_at at time zone 'UTC', 'HH24:MI:SS.US')
                   || 'Z'
               ) end,
               'is_project_manager',
                 public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, t.project_id),
               'allowed_actions', jsonb_build_object(
                 'view', true,
                 'view_pii', v_view_pii,
                 'view_payment', v_view_payment,
                 'propose_change', false,
                 'propose_change_code', 'PROPOSE_PENDING_W04_POLICY'
               )
             ) order by t.first_work_date desc, t.entry_id desc), '[]'::jsonb)
        from trimmed t
        left join lateral (
          select r.request_id, r.version
            from public.direct_entry_change_requests r
            join public.direct_entry_change_request_items i
              on i.request_id = r.request_id
           where i.entry_id = t.entry_id
             and r.state = 'PENDING'
           order by r.created_at desc, r.request_id desc
           limit 1
        ) pr on true
        left join lateral (
          select r.state, r.decided_at
            from public.direct_entry_change_requests r
            join public.direct_entry_change_request_items i
              on i.request_id = r.request_id
           where i.entry_id = t.entry_id
             and r.state in ('APPROVED', 'REJECTED')
           order by r.decided_at desc nulls last, r.request_id desc
           limit 1
        ) ld on true
    ),
    (
      select t.cursor from trimmed t
       order by t.first_work_date asc, t.entry_id asc
       limit 1
    )
  into v_scanned, v_items, v_next_cursor;

  return jsonb_build_object(
    'items', v_items,
    'scope', v_scope,
    'page_size', v_page_size,
    'has_more', v_scanned > v_page_size,
    'next_cursor', case when v_scanned > v_page_size then v_next_cursor else null end,
    'authorization_date', public.direct_entry_authorization_date()
  );
end;
$$;
revoke all on function public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer)
  to service_role;
comment on function public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer) is
  'P2.5-W03 worker directory page for the recruited/managed/all audiences. Keyset pagination, server-side '
  'filters, capability-gated masked payment and server-supplied allowed_actions (propose_change stays '
  'false until W04 closes the change-request audience policy). service_role only.';

-- -----------------------------------------------------------------------------
-- 3. Structural, ACL and policy self-check.
-- -----------------------------------------------------------------------------
do $$
declare
  v_signature text;
  v_secdef boolean;
  v_source text;
begin
  for v_signature in
    select unnest(array[
      'public.direct_entry_worker_directory_audience(uuid, uuid, text, text)',
      'public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer)'
    ])
  loop
    select p.prosecdef, pg_get_functiondef(p.oid)
      into v_secdef, v_source
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.oid = v_signature::regprocedure
       and p.proconfig @> array['search_path=pg_catalog, public'];
    if v_secdef is null or not v_secdef then
      raise exception 'P2.5-W03 function % must be SECURITY DEFINER with a fixed search_path', v_signature;
    end if;
  end loop;

  if has_function_privilege('anon', 'public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer)'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated', 'public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer)'::regprocedure, 'EXECUTE')
     or not has_function_privilege('service_role', 'public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer)'::regprocedure, 'EXECUTE') then
    raise exception 'P2.5-W03 worker directory RPC ACL self-check failed';
  end if;

  if has_function_privilege('anon', 'public.direct_entry_worker_directory_audience(uuid, uuid, text, text)'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated', 'public.direct_entry_worker_directory_audience(uuid, uuid, text, text)'::regprocedure, 'EXECUTE')
     or has_function_privilege('service_role', 'public.direct_entry_worker_directory_audience(uuid, uuid, text, text)'::regprocedure, 'EXECUTE') then
    raise exception 'P2.5-W03 audience guard must stay revoked from every role';
  end if;

  -- W04 lock: the directory must not advertise propose_change while the
  -- change-request audience/read/withdraw policy is still open.
  if v_source not like '%''propose_change'', false%' then
    raise exception 'P2.5-W03 must keep propose_change false until W04 closes the policy';
  end if;

  -- R1 policy lock: the all audience must keep BOTH bundles. Dropping
  -- change_review would silently force the Accounting/BoD reviewer bundle to take
  -- entry_admin (which T0 forbids), and dropping entry_admin would break Admin.
  select pg_get_functiondef(p.oid) into v_source
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.oid =
       'public.direct_entry_worker_directory_audience(uuid, uuid, text, text)'::regprocedure;
  if v_source not like '%''entry_admin''%' or v_source not like '%''change_review''%' then
    raise exception
      'P2.5-W03 all audience must accept entry_admin or change_review together with all scope';
  end if;

  raise notice 'P2.5-W03 migration self-check OK (worker directory audience + page projection)';
end
$$;

commit;
