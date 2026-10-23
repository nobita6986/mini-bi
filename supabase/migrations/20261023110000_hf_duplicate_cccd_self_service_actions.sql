-- HF: Duplicate CCCD report controlled actions & managed-project filter.
--
-- Scope:
--   1. Extract shared internal helper `public.direct_entry__internal_apply_entry_void(...)`
--      so reviewer-approved `ENTRY_VOID` (`direct_entry_apply_change_item`) and creator
--      self-withdraw (`direct_entry_self_withdraw_duplicate_cccd`) execute the exact same
--      domain void + revision + audit write without fake change requests or manual counter edits.
--   2. Add narrow creator-only RPC `public.direct_entry_self_withdraw_duplicate_cccd(...)`
--      (SECURITY DEFINER, pinned search_path, service_role ONLY) enforcing:
--        - canonical actor mapping (`direct_entry_assert_actor_mapping`);
--        - `direct_entries.created_by_user_id = p_app_user_id` (never `recruiter_id`, no
--          Admin/BoD/TL/PM override);
--        - deterministic `FOR UPDATE` locking across non-deleted entries sharing the canonical
--          CCCD so concurrent self-withdraws or `ON -> OFF` transitions cannot orphan-withdraw
--          the last remaining active episode;
--        - OCC (`expected_version`), non-deleted, non-voided, canonical CCCD, target `ON`, and
--          at least one other active `ON` non-voided non-deleted episode at commit time;
--        - idempotency replay via `direct_entry_rpc_idempotency`.
--   3. Expand `public.direct_entry_duplicate_cccd_report` with a 5-argument implementation
--      `(uuid, uuid, integer, integer, boolean)` (and retain the exact 4-argument delegate)
--      supporting `p_managed_only` via `direct_entry_actor_is_assigned_project_manager`
--      (returning full counterpart episodes per matched duplicate group, with totals/paging
--      computed after the filter) and projecting `entry_id`, `entry_version`, `can_mark_off`
--      (reusing `direct_entry_resolve_direct_edit_authority`), and `can_self_withdraw`.

begin;

-- -----------------------------------------------------------------------------
-- 1. Shared internal helper for domain ENTRY_VOID mutation + revision + audit.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry__internal_apply_entry_void(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_entry_version integer,
  p_reason_id uuid,
  p_audit_action text,
  p_audit_capability text,
  p_scope_kind text,
  p_scope_team_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_before jsonb;
  v_after jsonb;
  v_revision_id uuid;
begin
  v_before := public.direct_entry_entry_snapshot(p_entry_id);

  update public.direct_entries
     set voided_at = now(),
         voided_by_user_id = p_app_user_id,
         void_reason_id = p_reason_id,
         version = version + 1
   where entry_id = p_entry_id
     and deleted_at is null
     and voided_at is null;
  if not found then
    raise exception 'entry already voided' using errcode = '40001';
  end if;

  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, p_reason_id, v_before, v_after, p_entry_version + 1
  );

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, p_audit_action, p_audit_capability,
    p_entry_id::text, p_scope_kind, p_scope_team_id,
    'APPLIED', p_reason_id, v_revision_id, array['ENTRY_VOID']
  );

  return v_revision_id;
end;
$function$;

comment on function public.direct_entry__internal_apply_entry_void(
  uuid, uuid, uuid, integer, uuid, text, text, text, uuid
) is
  'Internal helper: applies domain ENTRY_VOID metadata, revision snapshot and immutable audit event on an already-locked direct_entries row. Revoked from all external/service roles.';

-- -----------------------------------------------------------------------------
-- 2. Refactor `direct_entry_apply_change_item` to delegate ENTRY_VOID to the
--    shared internal helper while keeping reviewer workflow semantics identical.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_apply_change_item(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_entry public.direct_entries,
  p_target_kind text,
  p_proposal jsonb,
  p_reason_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_before jsonb;
  v_after jsonb;
  v_reason_id uuid := p_reason_id;
  v_revision_id uuid;
  v_scope text;
  v_review_capability text := 'change_review';
  v_team_review boolean;
  v_team_id uuid;
  v_provider text;
  v_date date;
  v_recruiter_id uuid;
  v_target_project_id text;
  v_count integer;
  v_document_id uuid;
  v_status_version integer;
  v_latest public.direct_entry_employment_status_events%rowtype;
begin
  -- entry_void_apply_v1: keep the void-only reviewer grants separate from other changes.
  v_team_review := public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id) = p_entry.team_id;
  if p_target_kind = 'ENTRY_VOID' then
    if v_team_review then
      perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'team_manager_assign');
      v_scope := 'team';
      v_review_capability := 'team_manager_assign';
    elsif public.direct_entry_has_scope(p_app_user_id, 'all')
       and public.direct_entry_has_capability(p_app_user_id, 'entry_admin') then
      v_scope := 'all';
      v_review_capability := 'entry_admin';
    elsif public.direct_entry_has_scope(p_app_user_id, 'all')
       and public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit') then
      v_scope := 'all';
      v_review_capability := 'entry_privileged_edit';
    elsif public.direct_entry_has_scope(p_app_user_id, 'all')
       and public.direct_entry_has_capability(p_app_user_id, 'change_review') then
      v_scope := 'all';
      v_review_capability := 'change_review';
    else
      raise exception 'entry void review scope/capability denied' using errcode = '42501';
    end if;
  elsif v_team_review then
    v_scope := 'team';
    v_review_capability := 'team_manager_assign';
  else
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_review', p_entry.created_by_user_id,
      p_entry.team_id, p_entry.first_work_date
    );
  end if;
  -- P2.5-W05-R1 matrix: review needs the capability to SEE the data it decides, never
  -- the apply-side token. The all-scope review lock is asserted by the decision path
  -- (#55) before this helper runs, and DRAFT direct writes keep their own capabilities.
  if p_target_kind = 'DOCUMENT' then
    if not (public.direct_entry_has_capability(p_app_user_id, 'document_view')
            and public.direct_entry_has_capability(p_app_user_id, 'document_upload')) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  end if;
  if p_target_kind = 'ENTRY_VOID' then
    if p_proposal is distinct from '{}'::jsonb
       or p_entry.voided_at is not null
       or (select count(*) from public.direct_entry_change_request_items i
            where i.request_id = p_request_id and i.target_kind = 'ENTRY_VOID') <> 1
       or not exists (
         select 1 from public.direct_entry_submissions s
          where s.submission_id = p_entry.submission_id and s.state = 'SUBMITTED'
       ) then
      raise exception 'entry void target is not active' using errcode = '40001';
    end if;
    return public.direct_entry__internal_apply_entry_void(
      p_auth_subject,
      p_app_user_id,
      p_entry.entry_id,
      p_entry.version,
      v_reason_id,
      'change_request_approve',
      v_review_capability,
      v_scope,
      case when v_scope = 'team' then p_entry.team_id else null end
    );
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry.entry_id);
  if p_target_kind = 'ENTRY_FIELD' then
    if (p_proposal - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type']) <> '{}'::jsonb
       or p_proposal = '{}'::jsonb
       or (p_proposal ? 'worker_details'
           and public.direct_entry_w04_worker_details_allowed(p_proposal->'worker_details') is not true) then
      raise exception 'unsupported entry proposal field' using errcode = '22023';
    end if;
    v_recruiter_id := case when p_proposal ? 'recruiter_id'
      then (p_proposal->>'recruiter_id')::uuid else p_entry.recruiter_id end;
    v_date := case when p_proposal ? 'first_work_date'
      then (p_proposal->>'first_work_date')::date else p_entry.first_work_date end;
    v_target_project_id := case when p_proposal ? 'project_id'
      then p_proposal->>'project_id' else p_entry.project_id end;
    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id and m.is_current;
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    if v_provider = 'vendor' then
      v_team_id := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_recruiter_id and m.is_current;
      if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
    end if;
    if v_team_review then
      if v_team_id is distinct from p_entry.team_id then
        raise exception 'entry scope/capability denied' using errcode = '42501';
      end if;
      if (p_proposal ? 'recruiter_id' or p_proposal ? 'project_id' or p_proposal ? 'first_work_date')
         and (not public.direct_entry_project_team_scope_effective(p_entry.project_id, v_team_id)
           or not public.direct_entry_project_team_scope_effective(v_target_project_id, v_team_id)) then
        raise exception 'team leader project scope denied' using errcode = '42501';
      end if;
    else
      perform public.direct_entry_assert_entry_access(
        p_auth_subject, p_app_user_id, 'change_review',
        p_entry.created_by_user_id, v_team_id, v_date, v_scope
      );
    end if;
    update public.direct_entries set
      project_id = v_target_project_id,
      first_work_date = v_date,
      employee_code = case when p_proposal ? 'employee_code' then p_proposal->>'employee_code' else employee_code end,
      worker_details = case when p_proposal ? 'worker_details' then p_proposal->'worker_details' else worker_details end,
      recruiter_id = v_recruiter_id, team_id = v_team_id, provider_type = v_provider,
      labor_type = case when p_proposal ? 'labor_type' then p_proposal->>'labor_type' else labor_type end,
      version = version + 1
     where entry_id = p_entry.entry_id;
  elsif p_target_kind = 'PAYMENT' then
    if (p_proposal - array['state','account_number','bank_id','account_holder_name']) <> '{}'::jsonb then
      raise exception 'unsupported payment proposal field' using errcode = '22023';
    end if;
    insert into public.direct_entry_payments (
      entry_id, state, account_number, bank_id, account_holder_name, version
    ) values (
      p_entry.entry_id, p_proposal->>'state', p_proposal->>'account_number',
      p_proposal->>'bank_id', p_proposal->>'account_holder_name', 1
    ) on conflict (entry_id) do update set
      state = excluded.state, account_number = excluded.account_number,
      bank_id = excluded.bank_id, account_holder_name = excluded.account_holder_name,
      version = public.direct_entry_payments.version + 1, updated_at = now();
    update public.direct_entries set version = version + 1 where entry_id = p_entry.entry_id;
  elsif p_target_kind = 'WORK_STATUS' then
    if (p_proposal - array['status','effective_date','leave_reason']) <> '{}'::jsonb then
      raise exception 'unsupported status proposal field' using errcode = '22023';
    end if;
    select * into v_latest from public.direct_entry_employment_status_events
     where entry_id = p_entry.entry_id order by version desc limit 1 for update;
    v_status_version := coalesce(v_latest.version, 0) + 1;
    insert into public.direct_entry_employment_status_events (
      entry_id, status, effective_date, leave_date, leave_reason_text,
      version, actor_user_id, reason_id, supersedes_event_id
    ) values (
      p_entry.entry_id, p_proposal->>'status', (p_proposal->>'effective_date')::date,
      case when p_proposal->>'status' = 'OFF' then (p_proposal->>'effective_date')::date end,
      case when p_proposal->>'status' = 'OFF' then p_proposal->>'leave_reason' end,
      v_status_version, p_app_user_id, v_reason_id, null
    );
    update public.direct_entries set version = version + 1 where entry_id = p_entry.entry_id;
  elsif p_target_kind = 'DOCUMENT' then
    if (p_proposal - array['document_type','idempotency_key','checksum_sha256','size_bytes','mime_type']) <> '{}'::jsonb then
      raise exception 'unsupported document proposal field' using errcode = '22023';
    end if;
    select document_id into v_document_id
      from public.direct_entry_create_document_record(
        p_entry.candidate_id, p_proposal->>'document_type',
        p_proposal->>'idempotency_key', p_proposal->>'checksum_sha256',
        (p_proposal->>'size_bytes')::bigint, p_proposal->>'mime_type', p_app_user_id
      );
    update public.direct_entries set version = version + 1 where entry_id = p_entry.entry_id;
  else
    raise exception 'unsupported change target' using errcode = '22023';
  end if;
  v_after := public.direct_entry_entry_snapshot(p_entry.entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry.entry_id, p_app_user_id, v_reason_id, v_before, v_after, p_entry.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'change_request_approve', v_review_capability,
    p_entry.entry_id::text, v_scope,
    case when v_scope = 'team' then
      case when p_target_kind = 'ENTRY_FIELD' then v_team_id else p_entry.team_id end
      else null end,
    'APPLIED', v_reason_id, v_revision_id, array[p_target_kind]
  );
  return v_revision_id;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 3. Narrow creator-only self-withdraw RPC for active duplicate CCCD episodes.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_self_withdraw_duplicate_cccd(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry public.direct_entries%rowtype;
  v_cccd text;
  v_target_status text;
  v_other_active_count integer := 0;
  v_reason_id uuid;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_entry_id is null then
    raise exception 'entry id required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected entry version required' using errcode = '22023';
  end if;
  if p_idempotency_key is null
     or length(btrim(p_idempotency_key)) = 0
     or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select * into v_entry
    from public.direct_entries
   where entry_id = p_entry_id;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  if v_entry.created_by_user_id is distinct from p_app_user_id then
    raise exception 'self withdraw requires entry creator' using errcode = '42501';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'entry_self_withdraw_duplicate_cccd',
    p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id,
      'expected_version', p_expected_version,
      'reason', p_reason
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_cccd := case
    when v_entry.worker_details->'national_id'->>'state' = 'provided' then
      public.direct_entry_canonical_national_id(
        v_entry.worker_details->'national_id'->>'value'
      )
    else null
  end;

  -- Lock the target row AND all non-deleted episodes sharing the canonical CCCD in
  -- deterministic entry_id order so concurrent self-withdraws or ON->OFF mutations
  -- serialize cleanly without deadlocks or double-withdrawing a 2-row pair.
  perform 1
    from public.direct_entries e
   where e.entry_id = p_entry_id
      or (
        public.direct_entry_is_canonical_national_id(v_cccd)
        and e.deleted_at is null
        and e.worker_details->'national_id'->>'state' = 'provided'
        and public.direct_entry_canonical_national_id(
              e.worker_details->'national_id'->>'value'
            ) = v_cccd
      )
   order by e.entry_id asc
   for update;

  select * into v_entry
    from public.direct_entries
   where entry_id = p_entry_id;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  if v_entry.created_by_user_id is distinct from p_app_user_id then
    raise exception 'self withdraw requires entry creator' using errcode = '42501';
  end if;
  if v_entry.voided_at is not null then
    raise exception 'entry already voided' using errcode = '40001';
  end if;
  if v_entry.version <> p_expected_version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;

  v_cccd := case
    when v_entry.worker_details->'national_id'->>'state' = 'provided' then
      public.direct_entry_canonical_national_id(
        v_entry.worker_details->'national_id'->>'value'
      )
    else null
  end;
  if not public.direct_entry_is_canonical_national_id(v_cccd) then
    raise exception 'self withdraw target is not an active duplicate' using errcode = '40001';
  end if;

  select coalesce((
    select st.status
      from public.direct_entry_employment_status_events st
     where st.entry_id = v_entry.entry_id
     order by st.version desc
     limit 1
  ), 'UNCONFIRMED')
    into v_target_status;
  if v_target_status <> 'ON' then
    raise exception 'self withdraw target is not an active duplicate' using errcode = '40001';
  end if;

  select count(*)::int
    into v_other_active_count
    from public.direct_entries e
   where e.entry_id <> v_entry.entry_id
     and e.deleted_at is null
     and e.voided_at is null
     and e.worker_details->'national_id'->>'state' = 'provided'
     and public.direct_entry_canonical_national_id(
           e.worker_details->'national_id'->>'value'
         ) = v_cccd
     and coalesce((
           select st.status
             from public.direct_entry_employment_status_events st
            where st.entry_id = e.entry_id
            order by st.version desc
            limit 1
         ), 'UNCONFIRMED') = 'ON';

  if v_other_active_count < 1 then
    raise exception 'self withdraw target is not an active duplicate' using errcode = '40001';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_revision_id := public.direct_entry__internal_apply_entry_void(
    p_auth_subject,
    p_app_user_id,
    v_entry.entry_id,
    v_entry.version,
    v_reason_id,
    'entry_self_withdraw_duplicate_cccd',
    'entry_creator_self_withdraw',
    'own',
    null
  );

  v_result := jsonb_build_object(
    'entry_id', v_entry.entry_id,
    'version', v_entry.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'entry_self_withdraw_duplicate_cccd', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

comment on function public.direct_entry_self_withdraw_duplicate_cccd(
  uuid, uuid, uuid, integer, text, text
) is
  'HF creator self-withdraw for active duplicate CCCD episodes: enforces created_by_user_id = actor, OCC, idempotency, and live counterpart ON duplicate under row locks before applying ENTRY_VOID. service_role only.';

-- -----------------------------------------------------------------------------
-- 4. Duplicate CCCD report implementation (5 arguments, no defaults) +
--    retained exact 4-argument delegate.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_duplicate_cccd_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_page integer,
  p_page_size integer,
  p_managed_only boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authority text;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_managed_only boolean := coalesce(p_managed_only, false);
  v_offset integer;
  v_is_full_admin boolean := false;
  v_current_team_leader_team_id uuid;
  v_total_groups integer := 0;
  v_total_entries integer := 0;
  v_rows jsonb;
  v_has_more boolean := false;
  v_groups jsonb;
begin
  if v_page < 1 or v_page > 1000 then
    raise exception 'duplicate_report_page_invalid' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'duplicate_report_page_size_invalid' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  -- Authority before any read: an unauthorized actor never receives an empty page
  -- that would otherwise look like "no duplicates".
  v_authority :=
    public.direct_entry_assert_duplicate_cccd_reader(p_auth_subject, p_app_user_id);

  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    v_is_full_admin := true;
  exception when insufficient_privilege then
    v_is_full_admin := false;
  end;

  begin
    v_current_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
  exception when insufficient_privilege then
    v_current_team_leader_team_id := null;
  end;

  with canonical as (
    select e.entry_id,
           e.version as entry_version,
           e.submission_id,
           e.created_by_user_id,
           e.team_id,
           e.project_id,
           e.employee_code,
           e.first_work_date,
           nullif(btrim(coalesce(e.worker_details->>'display_name', '')), '') as display_name,
           public.direct_entry_canonical_national_id(
             e.worker_details->'national_id'->>'value'
           ) as cccd
      from public.direct_entries e
     where e.deleted_at is null and e.voided_at is null
       and e.worker_details->'national_id'->>'state' = 'provided'
  ),
  live as (
    select c.entry_id,
           c.entry_version,
           c.submission_id,
           c.created_by_user_id,
           c.team_id,
           c.project_id,
           c.employee_code,
           c.first_work_date,
           c.display_name,
           c.cccd,
           coalesce((
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = c.entry_id
              order by st.version desc
              limit 1
           ), 'UNCONFIRMED') as latest_status
      from canonical c
     -- Null, empty and unknown values, and values whose business length is not 9
     -- or 12, are not duplicates of anything and stay out of the report.
     where public.direct_entry_is_canonical_national_id(c.cccd)
       and coalesce((
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = c.entry_id
              order by st.version desc
              limit 1
           ), 'UNCONFIRMED') = 'ON'
  ),
  managed_projects as (
    select distinct l.project_id
      from live l
     where v_managed_only
       and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, l.project_id)
  ),
  grouped as (
    select l.cccd,
           count(*)::int as profile_count,
           count(distinct l.project_id)::int as project_count,
           count(*) filter (where l.latest_status = 'ON')::int as active_profile_count,
           min(l.first_work_date) as earliest_first_work_date,
           max(l.first_work_date) as latest_first_work_date
      from live l
     group by l.cccd
     -- One occurrence is a normal profile; only two or more are a duplicate.
    having count(*) >= 2
       and (
         not v_managed_only
         or bool_or(exists (
           select 1 from managed_projects mp where mp.project_id = l.project_id
         ))
       )
  ),
  page_groups as (
    select g.*
      from grouped g
     order by g.cccd
     limit v_page_size + 1
    offset v_offset
  )
  select coalesce((select count(*)::int from grouped), 0),
         coalesce((select sum(g.profile_count)::int from grouped g), 0),
         coalesce((
           select jsonb_agg(gp.row_json order by gp.cccd)
             from (
               select pg.cccd,
                      jsonb_build_object(
                        'cccd_last4', right(pg.cccd, 4),
                        'cccd_length', length(pg.cccd),
                        'profile_count', pg.profile_count,
                        'project_count', pg.project_count,
                        'active_profile_count', pg.active_profile_count,
                        'first_work_date',
                          pg_catalog.to_char(pg.earliest_first_work_date, 'YYYY-MM-DD'),
                        'latest_first_work_date',
                          pg_catalog.to_char(pg.latest_first_work_date, 'YYYY-MM-DD'),
                        'episodes', coalesce((
                          select jsonb_agg(jsonb_build_object(
                                   'entry_id', l.entry_id,
                                   'entry_version', l.entry_version,
                                   'employee_code', l.employee_code,
                                   'display_name', l.display_name,
                                   'project_id', l.project_id,
                                   'project_display', pj.display_name,
                                   'first_work_date',
                                     pg_catalog.to_char(l.first_work_date, 'YYYY-MM-DD'),
                                   'latest_status', l.latest_status,
                                   'active', l.latest_status = 'ON',
                                   'can_mark_off', (
                                     coalesce(sub.state, '') in ('DRAFT', 'SUBMITTED')
                                     and public.direct_entry_resolve_direct_edit_authority(
                                       p_auth_subject,
                                       p_app_user_id,
                                       l.created_by_user_id,
                                       l.team_id,
                                       l.project_id,
                                       v_is_full_admin,
                                       v_current_team_leader_team_id
                                     ) is not null
                                   ),
                                   'can_self_withdraw', (l.created_by_user_id = p_app_user_id)
                                 ) order by l.first_work_date asc, l.entry_id asc)
                            from live l
                            left join public.direct_entry_projects pj
                              on pj.project_id = l.project_id
                            left join public.direct_entry_submissions sub
                              on sub.submission_id = l.submission_id
                           where l.cccd = pg.cccd
                        ), '[]'::jsonb)
                      ) as row_json
                 from page_groups pg
             ) gp
         ), '[]'::jsonb)
    into v_total_groups, v_total_entries, v_rows;

  v_has_more := jsonb_array_length(v_rows) > v_page_size;
  if v_has_more then
    select coalesce(jsonb_agg(t.value order by t.ord), '[]'::jsonb)
      into v_groups
      from jsonb_array_elements(v_rows) with ordinality as t(value, ord)
     where t.ord <= v_page_size;
  else
    v_groups := v_rows;
  end if;

  return jsonb_build_object(
    'authority', v_authority,
    'authorization_date', public.direct_entry_authorization_date(),
    'page', v_page,
    'page_size', v_page_size,
    'total_groups', v_total_groups,
    'total_entries', v_total_entries,
    'has_more', v_has_more,
    'groups', v_groups
  );
end;
$function$;

comment on function public.direct_entry_duplicate_cccd_report(
  uuid, uuid, integer, integer, boolean
) is
  'HF active duplicate CCCD report with optional p_managed_only filter and per-episode action flags (can_mark_off via canonical direct-edit authority, can_self_withdraw via created_by_user_id). service_role only.';

create or replace function public.direct_entry_duplicate_cccd_report(
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
begin
  return public.direct_entry_duplicate_cccd_report(
    p_auth_subject, p_app_user_id, p_page, p_page_size, false
  );
end;
$function$;

comment on function public.direct_entry_duplicate_cccd_report(
  uuid, uuid, integer, integer
) is
  'Retained exact 4-argument duplicate CCCD report entry point: delegates to the 5-argument implementation with p_managed_only = false. service_role only.';

-- -----------------------------------------------------------------------------
-- 5. Align function owners to table owner when permitted, and grant internal
--    helper EXECUTE across SECURITY DEFINER owners when run under a distinct
--    migration runner role (`s0_t1c_runner`).
-- -----------------------------------------------------------------------------
do $align_hf_duplicate_cccd_owners$
declare
  v_table_owner_oid oid;
  v_table_owner name;
  v_sig text;
  v_proc_owner_oid oid;
  v_owner name;
begin
  select c.relowner, r.rolname
    into v_table_owner_oid, v_table_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entries'::pg_catalog.regclass;

  if v_table_owner is null then
    raise exception 'HF duplicate CCCD expected owner missing on direct_entries'
      using errcode = '55000';
  end if;

  foreach v_sig in array array[
    'public.direct_entry__internal_apply_entry_void(uuid,uuid,uuid,integer,uuid,text,text,text,uuid)',
    'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)',
    'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)',
    'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)',
    'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer)'
  ]
  loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(v_sig);

    if v_proc_owner_oid is distinct from v_table_owner_oid
       and pg_catalog.pg_has_role(current_user, v_table_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_table_owner);
    end if;
  end loop;

  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid in (
       'public.direct_entry__internal_apply_entry_void(uuid,uuid,uuid,integer,uuid,text,text,text,uuid)'::pg_catalog.regprocedure,
       'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::pg_catalog.regprocedure,
       'public.direct_entry_decide_change_request(uuid,uuid,uuid,integer,text,text,text)'::pg_catalog.regprocedure,
       'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)'::pg_catalog.regprocedure,
       'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::pg_catalog.regprocedure,
       'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer)'::pg_catalog.regprocedure
     )
  loop
    execute pg_catalog.format(
      'grant execute on function public.direct_entry__internal_apply_entry_void(uuid,uuid,uuid,integer,uuid,text,text,text,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_entry_snapshot(uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_write_revision(uuid,uuid,uuid,jsonb,jsonb,integer) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_reason(uuid,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_actor_mapping(uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_idempotency_begin(uuid,text,text,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_idempotency_finish(uuid,text,text,jsonb) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_payload_hash(jsonb) to %I',
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
      'grant execute on function public.direct_entry_assert_duplicate_cccd_reader(uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_authorization_date() to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_actor_app_user_admin(uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_actor_is_assigned_project_manager(uuid,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean) to %I',
      v_owner
    );
  end loop;
end;
$align_hf_duplicate_cccd_owners$;

-- -----------------------------------------------------------------------------
-- 6. Strict function ACLs (S0-T1-C invariant).
-- -----------------------------------------------------------------------------
revoke all on function public.direct_entry__internal_apply_entry_void(
  uuid, uuid, uuid, integer, uuid, text, text, text, uuid
) from public, anon, authenticated, service_role;

revoke all on function public.direct_entry_apply_change_item(
  uuid, uuid, uuid, public.direct_entries, text, jsonb, uuid
) from public, anon, authenticated, service_role;

revoke all on function public.direct_entry_self_withdraw_duplicate_cccd(
  uuid, uuid, uuid, integer, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_self_withdraw_duplicate_cccd(
  uuid, uuid, uuid, integer, text, text
) to service_role;

revoke all on function public.direct_entry_duplicate_cccd_report(
  uuid, uuid, integer, integer, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_duplicate_cccd_report(
  uuid, uuid, integer, integer, boolean
) to service_role;

revoke all on function public.direct_entry_duplicate_cccd_report(
  uuid, uuid, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_duplicate_cccd_report(
  uuid, uuid, integer, integer
) to service_role;

-- -----------------------------------------------------------------------------
-- 7. Install-time self-check (data-free).
-- -----------------------------------------------------------------------------
do $check$
declare
  v_internal constant pg_catalog.regprocedure :=
    'public.direct_entry__internal_apply_entry_void(uuid,uuid,uuid,integer,uuid,text,text,text,uuid)'::pg_catalog.regprocedure;
  v_apply constant pg_catalog.regprocedure :=
    'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::pg_catalog.regprocedure;
  v_withdraw constant pg_catalog.regprocedure :=
    'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)'::pg_catalog.regprocedure;
  v_report_5 constant pg_catalog.regprocedure :=
    'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::pg_catalog.regprocedure;
  v_report_4 constant pg_catalog.regprocedure :=
    'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer)'::pg_catalog.regprocedure;
  v_proc pg_catalog.regprocedure;
  v_secdef boolean;
  v_volatile "char";
  v_config text;
  v_owner_bypasses_rls boolean;
begin
  foreach v_proc in array array[v_internal, v_apply, v_withdraw, v_report_5, v_report_4]
  loop
    select p.prosecdef,
           p.provolatile,
           coalesce(pg_catalog.array_to_string(p.proconfig, ','), ''),
           (r.rolsuper or r.rolbypassrls)
      into v_secdef, v_volatile, v_config, v_owner_bypasses_rls
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_proc;

    if not coalesce(v_secdef, false)
       or v_config <> 'search_path=pg_catalog, public'
       or not coalesce(v_owner_bypasses_rls, false)
       or pg_catalog.has_function_privilege('public', v_proc, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_proc, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_proc, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(
             (select p2.proacl from pg_catalog.pg_proc p2 where p2.oid = v_proc),
             pg_catalog.acldefault('f', (select p2.proowner from pg_catalog.pg_proc p2 where p2.oid = v_proc))
           )) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       ) then
      raise exception 'HF duplicate CCCD RPC security definer owner/RLS/ACL boundary drift on %', v_proc
        using errcode = '55000';
    end if;

    if v_proc in (v_report_5, v_report_4) and v_volatile <> 's' then
      raise exception 'HF duplicate CCCD report must remain STABLE (% had %)', v_proc, v_volatile
        using errcode = '55000';
    end if;
  end loop;

  if pg_catalog.has_function_privilege('service_role', v_internal, 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', v_apply, 'EXECUTE') then
    raise exception 'HF duplicate CCCD internal void helpers must stay revoked from service_role'
      using errcode = '55000';
  end if;

  if not pg_catalog.has_function_privilege('service_role', v_withdraw, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_report_5, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_report_4, 'EXECUTE') then
    raise exception 'HF duplicate CCCD service entry points must grant EXECUTE to service_role'
      using errcode = '55000';
  end if;
end;
$check$;

commit;
