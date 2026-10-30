-- =============================================================================
-- Hotfix: Salary Advance Vendor Recruiter Exclusion, Worker Info & History
-- =============================================================================
-- 1. Exclude workers recruited by a Vendor (`provider_type = 'vendor'` on
--    `public.direct_entries` or `public.recruiter_provider_memberships`) from
--    Salary Advance worker picker (`salary_advance_list_project_workers`) and
--    reject request creation (`salary_advance_create_request`) with
--    `SALARY_ADVANCE_WORKER_VENDOR_RECRUITED` (PT409). Historical requests are
--    preserved untouched.
-- 2. Include canonical `worker_first_work_date`, `worker_recruiter_display_name`,
--    `worker_recruiter_code`, and `worker_provider_type` on request summaries
--    without exposing CCCD or sensitive fields.
-- 3. Include server-computed 30-day salary advance summary
--    (`worker_advance_30d_summary`) in `Asia/Ho_Chi_Minh` timezone on request
--    detail for authorized Project Accountants and Supervisory Viewers,
--    counting only requests with verified disbursement evidence
--    (`request_state = 'APPROVED' AND evidence_review_state = 'REVIEWED'`)
--    within the actor's authorized project scope using exact `bigint` VND math.
-- 4. Add `service_role`-only RPC `public.salary_advance_list_worker_history`
--    supporting `LAST_30_DAYS`, `THIS_MONTH`, `MONTH`, `ALL`, and `CUSTOM_RANGE`
--    filters in `Asia/Ho_Chi_Minh`, server-side total count & integer VND sum,
--    cursor pagination, and strict per-accountant project scope isolation.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Internal helper: canonical worker first_work_date & recruiter/vendor info
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance__internal_worker_recruiter_info(
  p_worker_entry_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry public.direct_entries%rowtype;
  v_recruiter public.recruiters%rowtype;
  v_has_recruiter boolean := false;
  v_has_vendor_membership boolean := false;
  v_vendor_id text := null;
  v_vendor_name text := null;
  v_is_vendor boolean := false;
  v_provider_type text := 'hrp';
  v_recruiter_code text := null;
  v_recruiter_name text := null;
  v_display_label text := 'Chưa cập nhật';
begin
  select e.*
    into v_entry
    from public.direct_entries e
   where e.entry_id = p_worker_entry_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'first_work_date', null,
      'recruiter_id', null,
      'recruiter_code', null,
      'recruiter_display_name', 'Chưa cập nhật',
      'provider_type', 'hrp',
      'vendor_id', null,
      'vendor_display_name', null,
      'is_vendor_recruited', false
    );
  end if;

  select r.*
    into v_recruiter
    from public.recruiters r
   where r.recruiter_id = v_entry.recruiter_id;
  v_has_recruiter := found;

  select true,
         m.vendor_id,
         nullif(pg_catalog.btrim(coalesce(v.display_name, '')), '')
    into v_has_vendor_membership,
         v_vendor_id,
         v_vendor_name
    from public.recruiter_provider_memberships m
    left join public.vendors v
      on v.vendor_id = m.vendor_id
   where m.recruiter_id = v_entry.recruiter_id
     and (m.provider_type = 'vendor' or m.vendor_id is not null)
     and (m.is_current = true or coalesce(v_entry.provider_type, '') = 'vendor')
   order by m.is_current desc, m.valid_from desc, m.membership_id desc
   limit 1;

  v_has_vendor_membership := coalesce(v_has_vendor_membership, false);
  v_is_vendor := (coalesce(v_entry.provider_type, '') = 'vendor') or v_has_vendor_membership;
  v_provider_type := case when v_is_vendor then 'vendor' else 'hrp' end;

  if v_has_recruiter then
    v_recruiter_code := nullif(pg_catalog.btrim(coalesce(v_recruiter.personnel_code, '')), '');
    v_recruiter_name := nullif(pg_catalog.btrim(coalesce(v_recruiter.display_name, '')), '');
  end if;

  if v_is_vendor then
    v_display_label := coalesce(v_vendor_name, v_recruiter_name, v_recruiter_code, 'Vendor');
  else
    v_display_label := coalesce(v_recruiter_name, v_recruiter_code, 'Chưa cập nhật');
  end if;

  return pg_catalog.jsonb_build_object(
    'first_work_date', pg_catalog.to_char(v_entry.first_work_date, 'YYYY-MM-DD'),
    'recruiter_id', v_entry.recruiter_id,
    'recruiter_code', v_recruiter_code,
    'recruiter_display_name', pg_catalog.left(v_display_label, 256),
    'provider_type', v_provider_type,
    'vendor_id', v_vendor_id,
    'vendor_display_name', v_vendor_name,
    'is_vendor_recruited', v_is_vendor
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 2. Internal helper: evaluate worker eligibility (including Vendor exclusion)
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance__internal_evaluate_worker(
  p_worker_entry_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry public.direct_entries%rowtype;
  v_sub_state text;
  v_display_name text := '';
  v_normalized_worker_name text := '';
  v_latest_status text := 'OFF';
  v_cccd text := null;
  v_active_on_project_count integer := 0;
  v_in_duplicate_cccd_group boolean := false;
  v_recruiter_info jsonb;
  v_is_vendor_recruited boolean := false;
  v_reasons jsonb := '[]'::jsonb;
  v_is_eligible boolean := false;
  v_pay record;
  v_account_number text := null;
  v_account_masked text := null;
  v_institution_name text := null;
  v_account_holder_name text := null;
  v_normalized_holder_name text := '';
  v_has_complete_bank boolean := false;
  v_is_self_owned_bank boolean := false;
  v_bank_ineligible_reason text := 'BANK_ACCOUNT_MISSING';
  v_bank_json jsonb := null;
begin
  select e.*
    into v_entry
    from public.direct_entries e
   where e.entry_id = p_worker_entry_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'employment_status', 'OFF',
      'active_on_project_count', 0,
      'has_duplicate_cccd', false,
      'is_vendor_recruited', false,
      'provider_type', 'hrp',
      'recruiter_display_name', 'Chưa cập nhật',
      'recruiter_code', null,
      'is_eligible', false,
      'ineligible_reasons', pg_catalog.jsonb_build_array('WORKER_STATUS_OFF'),
      'bank_transfer_eligible', false,
      'bank_ineligible_reason', 'BANK_ACCOUNT_MISSING',
      'bank_account', null
    );
  end if;

  select s.state
    into v_sub_state
    from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id;

  v_display_name := public.salary_advance__internal_worker_display_name(v_entry.worker_details);
  v_normalized_worker_name := public.salary_advance__internal_normalize_person_name(v_display_name);
  v_recruiter_info := public.salary_advance__internal_worker_recruiter_info(v_entry.entry_id);
  v_is_vendor_recruited := coalesce((v_recruiter_info->>'is_vendor_recruited')::boolean, false);

  if v_entry.deleted_at is not null
     or v_entry.voided_at is not null
     or coalesce(v_sub_state, '') <> 'SUBMITTED' then
    v_latest_status := 'OFF';
  else
    select coalesce(
             (
               select st.status
                 from public.direct_entry_employment_status_events st
                where st.entry_id = v_entry.entry_id
                order by st.version desc
                limit 1
             ),
             'UNCONFIRMED'
           )
      into v_latest_status;
  end if;

  if coalesce(v_entry.worker_details->'national_id'->>'state', '') = 'provided' then
    v_cccd := public.direct_entry_canonical_national_id(
      v_entry.worker_details->'national_id'->>'value'
    );
    if not public.direct_entry_is_canonical_national_id(v_cccd) then
      v_cccd := null;
    end if;
  end if;

  -- Count distinct projects where this worker is currently ON
  select count(distinct d.project_id)::integer
    into v_active_on_project_count
    from public.direct_entries d
   where d.deleted_at is null
     and d.voided_at is null
     and (
       d.entry_id = v_entry.entry_id
       or d.candidate_id = v_entry.candidate_id
       or (
         v_cccd is not null
         and coalesce(d.worker_details->'national_id'->>'state', '') = 'provided'
         and public.direct_entry_canonical_national_id(d.worker_details->'national_id'->>'value') = v_cccd
       )
     )
     and coalesce(
           (
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = d.entry_id
              order by st.version desc
              limit 1
           ),
           'UNCONFIRMED'
         ) = 'ON';

  -- Exact current duplicate CCCD report cluster logic (`direct_entry_duplicate_cccd_report`)
  if v_cccd is not null then
    select exists (
      with canonical as (
        select d.entry_id,
               d.project_id,
               d.first_work_date,
               public.direct_entry_canonical_national_id(
                 d.worker_details->'national_id'->>'value'
               ) as cccd
          from public.direct_entries d
         where d.deleted_at is null
           and d.voided_at is null
           and d.worker_details->'national_id'->>'state' = 'provided'
      ),
      statused as (
        select c.entry_id,
               c.cccd,
               case
                 when c.project_id is not null and c.first_work_date is not null then
                   count(*) over (
                     partition by c.cccd, c.project_id, c.first_work_date
                   )
                 else 1
               end as same_project_day_count
          from canonical c
         where public.direct_entry_is_canonical_national_id(c.cccd)
           and c.cccd = v_cccd
      ),
      live as (
        select s.entry_id,
               s.cccd
          from statused s
         where s.same_project_day_count >= 2
      )
      select 1
        from live l
       group by l.cccd
      having count(*) >= 2
    )
      into v_in_duplicate_cccd_group;
  end if;

  if v_latest_status = 'OFF' then
    v_reasons := v_reasons || pg_catalog.jsonb_build_array('WORKER_STATUS_OFF');
  elsif v_latest_status <> 'ON' then
    v_reasons := v_reasons || pg_catalog.jsonb_build_array('WORKER_STATUS_UNCONFIRMED');
  end if;

  if v_active_on_project_count >= 2 then
    v_reasons := v_reasons || pg_catalog.jsonb_build_array('WORKER_MULTI_PROJECT_ON');
  end if;

  if v_in_duplicate_cccd_group then
    v_reasons := v_reasons || pg_catalog.jsonb_build_array('WORKER_DUPLICATE_CCCD');
  end if;

  if v_is_vendor_recruited then
    v_reasons := v_reasons || pg_catalog.jsonb_build_array('WORKER_VENDOR_RECRUITED');
  end if;

  v_is_eligible := (
    v_latest_status = 'ON'
    and v_active_on_project_count < 2
    and not v_in_duplicate_cccd_group
    and not v_is_vendor_recruited
  );

  -- Evaluate worker bank account & self-owned name match
  select p.state,
         p.account_number,
         p.bank_id,
         p.bank_name,
         p.account_holder_name,
         p.version as payment_version,
         b.display_name as catalog_bank_name
    into v_pay
    from public.direct_entry_payments p
    left join public.direct_entry_banks b
      on b.bank_id = p.bank_id
   where p.entry_id = v_entry.entry_id;

  if found and coalesce(v_pay.state, '') = 'provided' then
    v_account_number := nullif(pg_catalog.btrim(coalesce(v_pay.account_number, '')), '');
    v_institution_name := coalesce(
      nullif(pg_catalog.btrim(coalesce(v_pay.bank_name, '')), ''),
      nullif(pg_catalog.btrim(coalesce(v_pay.catalog_bank_name, '')), ''),
      public.direct_entry_vietqr_bank_display_name(v_pay.bank_id),
      nullif(pg_catalog.btrim(coalesce(v_pay.bank_id, '')), '')
    );
    v_account_holder_name := nullif(pg_catalog.btrim(coalesce(v_pay.account_holder_name, '')), '');
    v_normalized_holder_name := public.salary_advance__internal_normalize_person_name(v_account_holder_name);

    if v_account_number is not null then
      if pg_catalog.char_length(v_account_number) <= 4 then
        v_account_masked := v_account_number;
      else
        v_account_masked := pg_catalog.repeat(
          '•',
          greatest(pg_catalog.char_length(v_account_number) - 4, 2)
        ) || pg_catalog.right(v_account_number, 4);
      end if;
    end if;

    v_has_complete_bank := (
      v_account_number is not null
      and v_account_holder_name is not null
      and v_normalized_holder_name <> ''
    );

    if v_has_complete_bank then
      v_is_self_owned_bank := (
        v_normalized_worker_name <> ''
        and v_normalized_holder_name = v_normalized_worker_name
      );
      v_bank_ineligible_reason := case
        when v_is_self_owned_bank then null
        else 'BANK_ACCOUNT_NOT_SELF_OWNED'
      end;
    else
      v_is_self_owned_bank := false;
      v_bank_ineligible_reason := 'BANK_ACCOUNT_MISSING';
    end if;

    if v_account_number is not null or v_institution_name is not null or v_account_holder_name is not null then
      v_bank_json := pg_catalog.jsonb_build_object(
        'bank_id', v_pay.bank_id,
        'institution_name', v_institution_name,
        'account_number', v_account_number,
        'account_number_masked', v_account_masked,
        'account_holder_name', v_account_holder_name,
        'normalized_holder_name', nullif(v_normalized_holder_name, ''),
        'normalized_worker_name', nullif(v_normalized_worker_name, ''),
        'has_bank_account', v_has_complete_bank,
        'is_self_owned', v_is_self_owned_bank,
        'payment_version', coalesce(v_pay.payment_version, 1)
      );
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'employment_status', v_latest_status,
    'active_on_project_count', v_active_on_project_count,
    'has_duplicate_cccd', v_in_duplicate_cccd_group,
    'is_vendor_recruited', v_is_vendor_recruited,
    'provider_type', coalesce(v_recruiter_info->>'provider_type', 'hrp'),
    'recruiter_display_name', coalesce(v_recruiter_info->>'recruiter_display_name', 'Chưa cập nhật'),
    'recruiter_code', v_recruiter_info->'recruiter_code',
    'is_eligible', v_is_eligible,
    'ineligible_reasons', v_reasons,
    'bank_transfer_eligible', v_is_self_owned_bank,
    'bank_ineligible_reason', v_bank_ineligible_reason,
    'bank_account', v_bank_json
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 3. Internal helper: 30-day salary advance summary for Accountant / Supervisory
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance__internal_worker_30d_summary(
  p_req public.salary_advance_requests,
  p_auth jsonb,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_access jsonb;
  v_is_assigned_accountant boolean := false;
  v_is_supervisory boolean := false;
  v_entry public.direct_entries%rowtype;
  v_accountant_project_ids text[];
  v_today date;
  v_from_date date;
  v_total_count integer := 0;
  v_total_amount bigint := 0;
begin
  v_access := public.salary_advance__internal_request_access(p_auth, p_app_user_id, p_req);
  v_is_assigned_accountant := coalesce((v_access->>'is_assigned_project_accountant')::boolean, false);
  v_is_supervisory := coalesce((v_access->>'is_supervisory_viewer')::boolean, false);

  if not v_is_assigned_accountant and not v_is_supervisory then
    return null;
  end if;

  select e.*
    into v_entry
    from public.direct_entries e
   where e.entry_id = p_req.worker_entry_id;

  v_accountant_project_ids := array(
    select pg_catalog.jsonb_array_elements_text(coalesce(p_auth->'accountant_project_ids', '[]'::jsonb))
  );

  v_today := coalesce(
    (p_auth->>'authorization_date')::date,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  );
  v_from_date := (v_today - 29);

  select count(*)::integer,
         coalesce(sum(r.requested_amount_vnd), 0)::bigint
    into v_total_count,
         v_total_amount
    from public.salary_advance_requests r
    join public.direct_entries de
      on de.entry_id = r.worker_entry_id
   where (
     r.worker_entry_id = p_req.worker_entry_id
     or (v_entry.candidate_id is not null and de.candidate_id = v_entry.candidate_id)
   )
     and (
       v_is_supervisory
       or r.project_id = any(v_accountant_project_ids)
     )
     and r.request_state = 'APPROVED'
     and r.evidence_review_state = 'REVIEWED'
     and (
       (coalesce(r.evidence_reviewed_at, r.decided_at, r.created_at) at time zone 'Asia/Ho_Chi_Minh')::date
       between v_from_date and v_today
     );

  return pg_catalog.jsonb_build_object(
    'window_days', 30,
    'window_from_date', pg_catalog.to_char(v_from_date, 'YYYY-MM-DD'),
    'window_to_date', pg_catalog.to_char(v_today, 'YYYY-MM-DD'),
    'timezone', 'Asia/Ho_Chi_Minh',
    'qualifying_rule', 'APPROVED_AND_EVIDENCE_REVIEWED',
    'total_count', coalesce(v_total_count, 0),
    'total_amount_vnd', coalesce(v_total_amount, 0)::bigint::text
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Internal helper: request summary with canonical work & recruiter fields
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance__internal_project_request_summary(
  p_req public.salary_advance_requests,
  p_auth jsonb,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry public.direct_entries%rowtype;
  v_project public.direct_entry_projects%rowtype;
  v_access jsonb;
  v_portrait jsonb;
  v_worker_eval jsonb;
  v_recruiter_info jsonb;
  v_payment_method text;
  v_evidence_kind text;
begin
  select e.*
    into v_entry
    from public.direct_entries e
   where e.entry_id = p_req.worker_entry_id;

  select pr.*
    into v_project
    from public.direct_entry_projects pr
   where pr.project_id = p_req.project_id;

  v_access := public.salary_advance__internal_request_access(p_auth, p_app_user_id, p_req);
  v_portrait := public.salary_advance__internal_resolve_worker_portrait(v_entry.candidate_id);
  v_worker_eval := public.salary_advance__internal_evaluate_worker(p_req.worker_entry_id);
  v_recruiter_info := public.salary_advance__internal_worker_recruiter_info(p_req.worker_entry_id);
  v_payment_method := coalesce(p_req.payment_method, 'CASH');
  v_evidence_kind := case
    when v_payment_method = 'BANK_TRANSFER' then 'BANK_TRANSFER_RECEIPT'
    else 'CASH_HANDOVER_PHOTO'
  end;

  return pg_catalog.jsonb_build_object(
    'request_id', p_req.request_id,
    'project_id', p_req.project_id,
    'project_display_name', coalesce(v_project.display_name, p_req.project_id),
    'worker_entry_id', p_req.worker_entry_id,
    'worker_employee_code', v_entry.employee_code,
    'worker_display_name', public.salary_advance__internal_worker_display_name(v_entry.worker_details),
    'worker_first_work_date', coalesce(
      v_recruiter_info->>'first_work_date',
      pg_catalog.to_char(v_entry.first_work_date, 'YYYY-MM-DD')
    ),
    'worker_recruiter_display_name', coalesce(v_recruiter_info->>'recruiter_display_name', 'Chưa cập nhật'),
    'worker_recruiter_code', v_recruiter_info->'recruiter_code',
    'worker_provider_type', coalesce(v_recruiter_info->>'provider_type', 'hrp'),
    'worker_portrait', v_portrait,
    'worker_eligibility', pg_catalog.jsonb_build_object(
      'employment_status', v_worker_eval->>'employment_status',
      'active_on_project_count', (v_worker_eval->>'active_on_project_count')::integer,
      'has_duplicate_cccd', (v_worker_eval->>'has_duplicate_cccd')::boolean,
      'is_eligible', (v_worker_eval->>'is_eligible')::boolean,
      'ineligible_reasons', v_worker_eval->'ineligible_reasons'
    ),
    'requested_amount_vnd', p_req.requested_amount_vnd::text,
    'initial_content', p_req.initial_content,
    'payment_method', v_payment_method,
    'evidence_kind', v_evidence_kind,
    'payment_destination_snapshot', p_req.payment_destination_snapshot,
    'request_state', p_req.request_state,
    'evidence_review_state', p_req.evidence_review_state,
    'version', p_req.version,
    'created_by_user_id', p_req.created_by_user_id,
    'created_by_display_name', public.salary_advance__internal_actor_display_name(p_req.created_by_user_id),
    'decided_by_user_id', p_req.decided_by_user_id,
    'decided_by_display_name', case
      when p_req.decided_by_user_id is not null
        then public.salary_advance__internal_actor_display_name(p_req.decided_by_user_id)
      else null
    end,
    'decided_at', case
      when p_req.decided_at is not null
        then pg_catalog.to_char(p_req.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      else null
    end,
    'decision_note', p_req.decision_note,
    'handled_externally_by_user_id', p_req.handled_externally_by_user_id,
    'handled_externally_by_display_name', case
      when p_req.handled_externally_by_user_id is not null
        then public.salary_advance__internal_actor_display_name(p_req.handled_externally_by_user_id)
      else null
    end,
    'handled_externally_at', case
      when p_req.handled_externally_at is not null
        then pg_catalog.to_char(p_req.handled_externally_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      else null
    end,
    'handled_externally_note', p_req.handled_externally_note,
    'withdrawn_by_user_id', p_req.withdrawn_by_user_id,
    'withdrawn_by_display_name', case
      when p_req.withdrawn_by_user_id is not null
        then public.salary_advance__internal_actor_display_name(p_req.withdrawn_by_user_id)
      else null
    end,
    'withdrawn_at', case
      when p_req.withdrawn_at is not null
        then pg_catalog.to_char(p_req.withdrawn_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      else null
    end,
    'withdrawn_note', p_req.withdrawn_note,
    'current_evidence', case
      when p_req.current_evidence_version >= 1 then
        pg_catalog.jsonb_build_object(
          'evidence_version', p_req.current_evidence_version,
          'evidence_kind', v_evidence_kind,
          'mime_type', p_req.current_evidence_mime_type,
          'size_bytes', p_req.current_evidence_size_bytes,
          'checksum_sha256', p_req.current_evidence_checksum_sha256,
          'uploaded_by_user_id', p_req.current_evidence_uploaded_by_user_id,
          'uploaded_by_display_name', public.salary_advance__internal_actor_display_name(p_req.current_evidence_uploaded_by_user_id),
          'uploaded_at', pg_catalog.to_char(p_req.current_evidence_uploaded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'reviewed_by_user_id', p_req.evidence_reviewed_by_user_id,
          'reviewed_by_display_name', case
            when p_req.evidence_reviewed_by_user_id is not null
              then public.salary_advance__internal_actor_display_name(p_req.evidence_reviewed_by_user_id)
            else null
          end,
          'reviewed_at', case
            when p_req.evidence_reviewed_at is not null
              then pg_catalog.to_char(p_req.evidence_reviewed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            else null
          end,
          'review_note', p_req.evidence_review_note,
          'reviewed_worker_portrait_document_id', p_req.reviewed_worker_portrait_document_id,
          'reviewed_worker_portrait_version', p_req.reviewed_worker_portrait_version
        )
      else null
    end,
    'current_project_accountant', v_access->'current_project_accountant',
    'allowed_actions', v_access->'allowed_actions',
    'last_activity_at', pg_catalog.to_char(p_req.last_activity_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'created_at', pg_catalog.to_char(p_req.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updated_at', pg_catalog.to_char(p_req.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 5. Internal helper: build request detail with 30-day advance summary
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance__internal_build_request_detail(
  p_req public.salary_advance_requests,
  p_auth jsonb,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_summary jsonb;
  v_events jsonb;
  v_evidence_versions jsonb;
  v_advance_30d jsonb;
  v_default_evidence_kind text;
begin
  v_summary := public.salary_advance__internal_project_request_summary(p_req, p_auth, p_app_user_id);
  v_advance_30d := public.salary_advance__internal_worker_30d_summary(p_req, p_auth, p_app_user_id);
  v_default_evidence_kind := case
    when coalesce(p_req.payment_method, 'CASH') = 'BANK_TRANSFER' then 'BANK_TRANSFER_RECEIPT'
    else 'CASH_HANDOVER_PHOTO'
  end;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'event_id', ev.event_id,
               'event_seq', ev.event_seq,
               'event_type', ev.event_type,
               'actor_user_id', ev.actor_user_id,
               'actor_display_name', public.salary_advance__internal_actor_display_name(ev.actor_user_id),
               'actor_role', ev.actor_role,
               'from_request_state', ev.from_request_state,
               'to_request_state', ev.to_request_state,
               'from_evidence_review_state', ev.from_evidence_review_state,
               'to_evidence_review_state', ev.to_evidence_review_state,
               'message_text', ev.message_text,
               'evidence_kind', case
                 when ev.event_type in ('EVIDENCE_UPLOADED', 'EVIDENCE_REVIEWED', 'EVIDENCE_RETAKE_REQUESTED')
                   then coalesce(ev.evidence_kind, v_default_evidence_kind)
                 else null
               end,
               'evidence_version', ev.evidence_version,
               'evidence_mime_type', ev.evidence_mime_type,
               'evidence_size_bytes', ev.evidence_size_bytes,
               'evidence_checksum_sha256', ev.evidence_checksum_sha256,
               'reviewed_worker_portrait_document_id', ev.reviewed_worker_portrait_document_id,
               'reviewed_worker_portrait_version', ev.reviewed_worker_portrait_version,
               'created_at', pg_catalog.to_char(ev.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             )
             order by ev.event_seq asc
           ),
           '[]'::jsonb
         )
    into v_events
    from public.salary_advance_events ev
   where ev.request_id = p_req.request_id;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'evidence_version', ev.evidence_version,
               'evidence_kind', coalesce(ev.evidence_kind, v_default_evidence_kind),
               'event_id', ev.event_id,
               'mime_type', ev.evidence_mime_type,
               'size_bytes', ev.evidence_size_bytes,
               'checksum_sha256', ev.evidence_checksum_sha256,
               'caption_note', ev.message_text,
               'uploaded_by_user_id', ev.actor_user_id,
               'uploaded_by_display_name', public.salary_advance__internal_actor_display_name(ev.actor_user_id),
               'uploaded_at', pg_catalog.to_char(ev.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             )
             order by ev.evidence_version desc
           ),
           '[]'::jsonb
         )
    into v_evidence_versions
    from public.salary_advance_events ev
   where ev.request_id = p_req.request_id
     and ev.event_type = 'EVIDENCE_UPLOADED';

  return pg_catalog.jsonb_build_object(
    'request', v_summary,
    'events', v_events,
    'evidence_versions', v_evidence_versions,
    'worker_advance_30d_summary', v_advance_30d
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 6. RPC: list project workers (excluding Vendor-recruited workers)
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance_list_project_workers(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_search text default null,
  p_cursor text default null,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_page_size integer;
  v_search text;
  v_cursor_code text := null;
  v_cursor_id uuid := null;
  v_items jsonb := '[]'::jsonb;
  v_total_fetched integer := 0;
  v_next_cursor text := null;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if p_project_id is null or p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'SALARY_ADVANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  if not public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_project_id) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  v_page_size := coalesce(p_page_size, 25);
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'SALARY_ADVANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  v_search := public.salary_advance__internal_validate_text(
    p_search,
    1,
    120,
    true,
    'SALARY_ADVANCE_QUERY_INVALID'
  );

  if p_cursor is not null and pg_catalog.btrim(p_cursor) <> '' then
    if p_cursor !~ '^[^|]+\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;
    v_cursor_code := pg_catalog.split_part(p_cursor, '|', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, '|', 2)::uuid;
  end if;

  with eligible as (
    select e.entry_id as worker_entry_id,
           e.employee_code,
           public.salary_advance__internal_worker_display_name(e.worker_details) as display_name,
           pg_catalog.to_char(e.first_work_date, 'YYYY-MM-DD') as first_work_date,
           (public.salary_advance__internal_resolve_worker_portrait(e.candidate_id) is not null) as has_portrait
      from public.direct_entries e
      join public.direct_entry_submissions s
        on s.submission_id = e.submission_id
     where e.project_id = p_project_id
       and e.deleted_at is null
       and e.voided_at is null
       and s.state = 'SUBMITTED'
       and coalesce(e.provider_type, '') <> 'vendor'
       and not exists (
         select 1
           from public.recruiter_provider_memberships m
          where m.recruiter_id = e.recruiter_id
            and m.is_current = true
            and (m.provider_type = 'vendor' or m.vendor_id is not null)
       )
  ),
  filtered as (
    select w.*
      from eligible w
     where (
       v_search is null
       or pg_catalog.lower(w.employee_code) like '%' || pg_catalog.lower(v_search) || '%'
       or pg_catalog.lower(w.display_name) like '%' || pg_catalog.lower(v_search) || '%'
     )
       and (
         v_cursor_code is null
         or (w.employee_code, w.worker_entry_id::text) > (v_cursor_code, v_cursor_id::text)
       )
     order by w.employee_code asc, w.worker_entry_id asc
     limit v_page_size + 1
  ),
  trimmed as (
    select t.*,
           public.salary_advance__internal_evaluate_worker(t.worker_entry_id) as eval
      from (
        select *
          from filtered
         order by employee_code asc, worker_entry_id asc
         limit v_page_size
      ) t
  )
  select (select count(*)::integer from filtered),
         coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'worker_entry_id', t.worker_entry_id,
               'employee_code', t.employee_code,
               'display_name', t.display_name,
               'first_work_date', t.first_work_date,
               'provider_type', coalesce(t.eval->>'provider_type', 'hrp'),
               'recruiter_display_name', t.eval->>'recruiter_display_name',
               'recruiter_code', t.eval->'recruiter_code',
               'has_portrait', t.has_portrait,
               'employment_status', t.eval->>'employment_status',
               'active_on_project_count', (t.eval->>'active_on_project_count')::integer,
               'has_duplicate_cccd', (t.eval->>'has_duplicate_cccd')::boolean,
               'is_eligible', (t.eval->>'is_eligible')::boolean,
               'ineligible_reasons', t.eval->'ineligible_reasons',
               'bank_transfer_eligible', (t.eval->>'bank_transfer_eligible')::boolean,
               'bank_ineligible_reason', t.eval->'bank_ineligible_reason',
               'bank_account', case
                 when t.eval->'bank_account' is not null
                      and pg_catalog.jsonb_typeof(t.eval->'bank_account') = 'object' then
                   pg_catalog.jsonb_build_object(
                     'bank_id', t.eval->'bank_account'->'bank_id',
                     'institution_name', t.eval->'bank_account'->'institution_name',
                     'account_number', t.eval->'bank_account'->'account_number',
                     'account_number_masked', t.eval->'bank_account'->'account_number_masked',
                     'account_holder_name', t.eval->'bank_account'->'account_holder_name',
                     'has_bank_account', t.eval->'bank_account'->'has_bank_account',
                     'is_self_owned', t.eval->'bank_account'->'is_self_owned'
                   )
                 else null
               end
             )
             order by t.employee_code asc, t.worker_entry_id asc
           ),
           '[]'::jsonb
         ),
         (
           select t2.employee_code || '|' || t2.worker_entry_id::text
             from trimmed t2
            order by t2.employee_code desc, t2.worker_entry_id desc
            limit 1
         )
    into v_total_fetched, v_items, v_next_cursor
    from trimmed t;

  return pg_catalog.jsonb_build_object(
    'project_id', p_project_id,
    'workers', v_items,
    'has_more', (v_total_fetched > v_page_size),
    'next_cursor', case when v_total_fetched > v_page_size then v_next_cursor else null end
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 7. RPC: create salary advance request (enforcing Vendor recruiter exclusion)
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance_create_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_worker_entry_id uuid,
  p_requested_amount_vnd text,
  p_initial_content text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_payment_method text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_today date;
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_payment_method text;
  v_project public.direct_entry_projects%rowtype;
  v_acct_info jsonb;
  v_entry public.direct_entries%rowtype;
  v_worker_eval jsonb;
  v_destination_snapshot jsonb := null;
  v_amount bigint;
  v_content text;
  v_now timestamptz := now();
  v_req public.salary_advance_requests%rowtype;
  v_detail jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);
  v_today := (v_auth->>'authorization_date')::date;

  v_idem_key := public.salary_advance__internal_validate_text(
    p_idempotency_key,
    8,
    128,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );
  v_fingerprint := public.salary_advance__internal_validate_text(
    p_request_fingerprint,
    16,
    512,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sal_adv_idem:' || p_app_user_id::text || ':' || v_idem_key, 0)
  );

  select i.*
    into v_existing_idem
    from public.salary_advance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.action <> 'CREATE_REQUEST'
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  v_payment_method := pg_catalog.upper(pg_catalog.btrim(coalesce(p_payment_method, '')));
  if v_payment_method not in ('CASH', 'BANK_TRANSFER') then
    raise exception 'SALARY_ADVANCE_PAYMENT_METHOD_INVALID'
      using errcode = '22023';
  end if;

  if p_project_id is null or p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'SALARY_ADVANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  if not public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_project_id) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  select p.*
    into v_project
    from public.direct_entry_projects p
   where p.project_id = p_project_id;

  if not found then
    raise exception 'SALARY_ADVANCE_PROJECT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if not v_project.active then
    raise exception 'SALARY_ADVANCE_PROJECT_INACTIVE'
      using errcode = 'PT409';
  end if;

  v_acct_info := public.vendor_finance__internal_resolve_active_project_accountant(
    p_project_id,
    v_today
  );

  if not coalesce((v_acct_info->>'has_assignment')::boolean, false)
     or not coalesce((v_acct_info->>'accountant_active')::boolean, false) then
    raise exception 'SALARY_ADVANCE_PROJECT_ACCOUNTANT_UNASSIGNED'
      using errcode = 'PT409';
  end if;

  if p_worker_entry_id is null then
    raise exception 'SALARY_ADVANCE_WORKER_INVALID'
      using errcode = '22023';
  end if;

  select e.*
    into v_entry
    from public.direct_entries e
    join public.direct_entry_submissions s
      on s.submission_id = e.submission_id
   where e.entry_id = p_worker_entry_id
     and e.deleted_at is null
     and e.voided_at is null
     and s.state = 'SUBMITTED';

  if not found then
    raise exception 'SALARY_ADVANCE_WORKER_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_entry.project_id <> p_project_id then
    raise exception 'SALARY_ADVANCE_WORKER_PROJECT_MISMATCH'
      using errcode = '22023';
  end if;

  v_worker_eval := public.salary_advance__internal_evaluate_worker(p_worker_entry_id);

  if coalesce((v_worker_eval->>'is_vendor_recruited')::boolean, false) then
    raise exception 'SALARY_ADVANCE_WORKER_VENDOR_RECRUITED'
      using errcode = 'PT409';
  end if;

  if coalesce(v_worker_eval->>'employment_status', 'UNCONFIRMED') <> 'ON' then
    raise exception 'SALARY_ADVANCE_WORKER_INELIGIBLE_STATUS'
      using errcode = 'PT409';
  end if;

  if coalesce((v_worker_eval->>'active_on_project_count')::integer, 0) >= 2 then
    raise exception 'SALARY_ADVANCE_WORKER_MULTI_PROJECT_ON'
      using errcode = 'PT409';
  end if;

  if coalesce((v_worker_eval->>'has_duplicate_cccd')::boolean, false) then
    raise exception 'SALARY_ADVANCE_WORKER_DUPLICATE_CCCD'
      using errcode = 'PT409';
  end if;

  if v_payment_method = 'BANK_TRANSFER' then
    if coalesce(v_worker_eval->>'bank_ineligible_reason', '') = 'BANK_ACCOUNT_MISSING' then
      raise exception 'SALARY_ADVANCE_BANK_ACCOUNT_MISSING'
        using errcode = 'PT409';
    end if;

    if not coalesce((v_worker_eval->>'bank_transfer_eligible')::boolean, false) then
      raise exception 'SALARY_ADVANCE_BANK_ACCOUNT_NOT_SELF_OWNED'
        using errcode = 'PT409';
    end if;

    v_destination_snapshot := pg_catalog.jsonb_build_object(
      'bank_id', v_worker_eval->'bank_account'->'bank_id',
      'institution_name', coalesce(
        nullif(pg_catalog.btrim(coalesce(v_worker_eval->'bank_account'->>'institution_name', '')), ''),
        public.direct_entry_vietqr_bank_display_name(v_worker_eval->'bank_account'->>'bank_id'),
        nullif(pg_catalog.btrim(coalesce(v_worker_eval->'bank_account'->>'bank_id', '')), ''),
        'Ngân hàng (đã cung cấp STK)'
      ),
      'account_number', v_worker_eval->'bank_account'->>'account_number',
      'account_number_masked', v_worker_eval->'bank_account'->>'account_number_masked',
      'account_holder_name', v_worker_eval->'bank_account'->>'account_holder_name',
      'normalized_holder_name', v_worker_eval->'bank_account'->>'normalized_holder_name',
      'payment_version', coalesce((v_worker_eval->'bank_account'->>'payment_version')::integer, 1),
      'captured_at', pg_catalog.to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    );
  end if;

  v_amount := public.salary_advance__internal_parse_positive_amount(p_requested_amount_vnd);
  v_content := public.salary_advance__internal_validate_text(
    p_initial_content,
    1,
    2000,
    false,
    'SALARY_ADVANCE_CONTENT_INVALID'
  );

  perform pg_catalog.set_config('salary_advance.write_marker', 'on', true);

  insert into public.salary_advance_requests (
    project_id,
    worker_entry_id,
    requested_amount_vnd,
    initial_content,
    payment_method,
    payment_destination_snapshot,
    request_state,
    evidence_review_state,
    version,
    created_by_user_id,
    last_activity_at,
    last_actor_user_id,
    created_at,
    updated_at
  ) values (
    p_project_id,
    p_worker_entry_id,
    v_amount,
    v_content,
    v_payment_method,
    v_destination_snapshot,
    'OPEN',
    'NOT_UPLOADED',
    1,
    p_app_user_id,
    v_now,
    p_app_user_id,
    v_now,
    v_now
  )
  returning * into v_req;

  insert into public.salary_advance_events (
    request_id,
    event_seq,
    event_type,
    actor_user_id,
    actor_role,
    from_request_state,
    to_request_state,
    from_evidence_review_state,
    to_evidence_review_state,
    message_text,
    created_at
  ) values (
    v_req.request_id,
    1,
    'REQUEST_CREATED',
    p_app_user_id,
    'PROJECT_MANAGER',
    null,
    'OPEN',
    null,
    'NOT_UPLOADED',
    v_content,
    v_now
  );

  v_detail := public.salary_advance__internal_build_request_detail(v_req, v_auth, p_app_user_id);

  insert into public.salary_advance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload,
    created_at
  ) values (
    p_app_user_id,
    v_idem_key,
    'CREATE_REQUEST',
    v_fingerprint,
    v_detail,
    v_now
  );

  return v_detail || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

-- -----------------------------------------------------------------------------
-- 8. RPC: list worker salary advance history (server-filtered & aggregated)
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance_list_worker_history(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_period_mode text default 'THIS_MONTH',
  p_month text default null,
  p_from_date text default null,
  p_to_date text default null,
  p_cursor text default null,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_is_assigned_accountant boolean := false;
  v_is_supervisory boolean := false;
  v_entry public.direct_entries%rowtype;
  v_accountant_project_ids text[];
  v_today date;
  v_mode text;
  v_raw_month text;
  v_raw_from text;
  v_raw_to text;
  v_resolved_month text := null;
  v_filter_from date := null;
  v_filter_to date := null;
  v_page_size integer;
  v_cursor_ts timestamptz := null;
  v_cursor_id uuid := null;
  v_total_count integer := 0;
  v_total_amount bigint := 0;
  v_fetched_count integer := 0;
  v_items jsonb := '[]'::jsonb;
  v_next_cursor text := null;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  if p_request_id is null then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  v_is_assigned_accountant := coalesce((v_access->>'is_assigned_project_accountant')::boolean, false);
  v_is_supervisory := coalesce((v_access->>'is_supervisory_viewer')::boolean, false);

  if not v_is_assigned_accountant and not v_is_supervisory then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  v_page_size := coalesce(p_page_size, 20);
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'SALARY_ADVANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  v_today := coalesce(
    (v_auth->>'authorization_date')::date,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  );

  v_mode := pg_catalog.upper(pg_catalog.btrim(coalesce(nullif(pg_catalog.btrim(p_period_mode), ''), 'THIS_MONTH')));
  v_raw_month := nullif(pg_catalog.btrim(coalesce(p_month, '')), '');
  v_raw_from := nullif(pg_catalog.btrim(coalesce(p_from_date, '')), '');
  v_raw_to := nullif(pg_catalog.btrim(coalesce(p_to_date, '')), '');

  if v_mode = 'LAST_30_DAYS' then
    if v_raw_month is not null or v_raw_from is not null or v_raw_to is not null then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;
    v_filter_from := (v_today - 29);
    v_filter_to := v_today;

  elsif v_mode = 'THIS_MONTH' then
    if v_raw_month is not null or v_raw_from is not null or v_raw_to is not null then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;
    v_filter_from := pg_catalog.date_trunc('month', v_today::timestamp)::date;
    v_filter_to := (pg_catalog.date_trunc('month', v_today::timestamp) + interval '1 month - 1 day')::date;
    v_resolved_month := pg_catalog.to_char(v_today, 'YYYY-MM');

  elsif v_mode = 'MONTH' then
    if v_raw_month is null
       or v_raw_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
       or v_raw_from is not null
       or v_raw_to is not null then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;
    v_filter_from := pg_catalog.to_date(v_raw_month || '-01', 'YYYY-MM-DD');
    v_filter_to := (v_filter_from + interval '1 month - 1 day')::date;
    v_resolved_month := v_raw_month;

  elsif v_mode = 'ALL' then
    if v_raw_month is not null or v_raw_from is not null or v_raw_to is not null then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;
    v_filter_from := null;
    v_filter_to := null;

  elsif v_mode = 'CUSTOM_RANGE' then
    if v_raw_month is not null or (v_raw_from is null and v_raw_to is null) then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;

    if v_raw_from is not null then
      if v_raw_from !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'SALARY_ADVANCE_QUERY_INVALID'
          using errcode = '22023';
      end if;
      begin
        v_filter_from := v_raw_from::date;
      exception
        when others then
          raise exception 'SALARY_ADVANCE_QUERY_INVALID'
            using errcode = '22023';
      end;
      if pg_catalog.to_char(v_filter_from, 'YYYY-MM-DD') <> v_raw_from then
        raise exception 'SALARY_ADVANCE_QUERY_INVALID'
          using errcode = '22023';
      end if;
    end if;

    if v_raw_to is not null then
      if v_raw_to !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'SALARY_ADVANCE_QUERY_INVALID'
          using errcode = '22023';
      end if;
      begin
        v_filter_to := v_raw_to::date;
      exception
        when others then
          raise exception 'SALARY_ADVANCE_QUERY_INVALID'
            using errcode = '22023';
      end;
      if pg_catalog.to_char(v_filter_to, 'YYYY-MM-DD') <> v_raw_to then
        raise exception 'SALARY_ADVANCE_QUERY_INVALID'
          using errcode = '22023';
      end if;
    end if;

    if v_filter_from is not null and v_filter_to is not null and v_filter_from > v_filter_to then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;

  else
    raise exception 'SALARY_ADVANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  if p_cursor is not null and pg_catalog.btrim(p_cursor) <> '' then
    if p_cursor !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;
    v_cursor_ts := pg_catalog.split_part(p_cursor, '|', 1)::timestamptz;
    v_cursor_id := pg_catalog.split_part(p_cursor, '|', 2)::uuid;
  end if;

  select e.*
    into v_entry
    from public.direct_entries e
   where e.entry_id = v_req.worker_entry_id;

  v_accountant_project_ids := array(
    select pg_catalog.jsonb_array_elements_text(coalesce(v_auth->'accountant_project_ids', '[]'::jsonb))
  );

  with matching as (
    select r.request_id,
           r.project_id,
           coalesce(pr.display_name, r.project_id) as project_display_name,
           r.worker_entry_id,
           de.employee_code as worker_employee_code,
           public.salary_advance__internal_worker_display_name(de.worker_details) as worker_display_name,
           r.requested_amount_vnd,
           coalesce(r.payment_method, 'CASH') as payment_method,
           r.initial_content,
           r.request_state,
           r.evidence_review_state,
           coalesce(r.evidence_reviewed_at, r.decided_at, r.created_at) as effective_at,
           (coalesce(r.evidence_reviewed_at, r.decided_at, r.created_at) at time zone 'Asia/Ho_Chi_Minh')::date as effective_date,
           r.created_at,
           r.decided_at,
           r.evidence_reviewed_at,
           r.created_by_user_id,
           r.decided_by_user_id,
           r.evidence_reviewed_by_user_id
      from public.salary_advance_requests r
      join public.direct_entries de
        on de.entry_id = r.worker_entry_id
      left join public.direct_entry_projects pr
        on pr.project_id = r.project_id
     where (
       r.worker_entry_id = v_req.worker_entry_id
       or (v_entry.candidate_id is not null and de.candidate_id = v_entry.candidate_id)
     )
       and (
         v_is_supervisory
         or r.project_id = any(v_accountant_project_ids)
       )
       and r.request_state = 'APPROVED'
       and r.evidence_review_state = 'REVIEWED'
       and (
         v_filter_from is null
         or (coalesce(r.evidence_reviewed_at, r.decided_at, r.created_at) at time zone 'Asia/Ho_Chi_Minh')::date >= v_filter_from
       )
       and (
         v_filter_to is null
         or (coalesce(r.evidence_reviewed_at, r.decided_at, r.created_at) at time zone 'Asia/Ho_Chi_Minh')::date <= v_filter_to
       )
  ),
  agg as (
    select count(*)::integer as total_count,
           coalesce(sum(m.requested_amount_vnd), 0)::bigint as total_amount
      from matching m
  ),
  paged as (
    select m.*
      from matching m
     where (
       v_cursor_ts is null
       or (m.effective_at, m.request_id) < (v_cursor_ts, v_cursor_id)
     )
     order by m.effective_at desc, m.request_id desc
     limit v_page_size + 1
  ),
  trimmed as (
    select p.*
      from paged p
     order by p.effective_at desc, p.request_id desc
     limit v_page_size
  )
  select (select a.total_count from agg a),
         (select a.total_amount from agg a),
         (select count(*)::integer from paged),
         coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'request_id', t.request_id,
               'project_id', t.project_id,
               'project_display_name', t.project_display_name,
               'worker_entry_id', t.worker_entry_id,
               'worker_employee_code', t.worker_employee_code,
               'worker_display_name', t.worker_display_name,
               'requested_amount_vnd', t.requested_amount_vnd::text,
               'payment_method', t.payment_method,
               'initial_content', t.initial_content,
               'request_state', t.request_state,
               'evidence_review_state', t.evidence_review_state,
               'effective_date', pg_catalog.to_char(t.effective_date, 'YYYY-MM-DD'),
               'effective_at', pg_catalog.to_char(t.effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'created_at', pg_catalog.to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'decided_at', case
                 when t.decided_at is not null
                   then pg_catalog.to_char(t.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 else null
               end,
               'evidence_reviewed_at', case
                 when t.evidence_reviewed_at is not null
                   then pg_catalog.to_char(t.evidence_reviewed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 else null
               end,
               'created_by_display_name', public.salary_advance__internal_actor_display_name(t.created_by_user_id),
               'decided_by_display_name', case
                 when t.decided_by_user_id is not null
                   then public.salary_advance__internal_actor_display_name(t.decided_by_user_id)
                 else null
               end,
               'evidence_reviewed_by_display_name', case
                 when t.evidence_reviewed_by_user_id is not null
                   then public.salary_advance__internal_actor_display_name(t.evidence_reviewed_by_user_id)
                 else null
               end
             )
             order by t.effective_at desc, t.request_id desc
           ),
           '[]'::jsonb
         ),
         (
           select pg_catalog.to_char(t2.effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                  || '|' || t2.request_id::text
             from trimmed t2
            order by t2.effective_at asc, t2.request_id asc
            limit 1
         )
    into v_total_count,
         v_total_amount,
         v_fetched_count,
         v_items,
         v_next_cursor
    from trimmed t;

  return pg_catalog.jsonb_build_object(
    'request_id', v_req.request_id,
    'worker_entry_id', v_req.worker_entry_id,
    'worker_employee_code', v_entry.employee_code,
    'worker_display_name', public.salary_advance__internal_worker_display_name(v_entry.worker_details),
    'period_mode', v_mode,
    'month', v_resolved_month,
    'from_date', case
      when v_filter_from is not null then pg_catalog.to_char(v_filter_from, 'YYYY-MM-DD')
      else null
    end,
    'to_date', case
      when v_filter_to is not null then pg_catalog.to_char(v_filter_to, 'YYYY-MM-DD')
      else null
    end,
    'timezone', 'Asia/Ho_Chi_Minh',
    'qualifying_rule', 'APPROVED_AND_EVIDENCE_REVIEWED',
    'total_count', coalesce(v_total_count, 0),
    'total_amount_vnd', coalesce(v_total_amount, 0)::bigint::text,
    'items', v_items,
    'has_more', (v_fetched_count > v_page_size),
    'next_cursor', case when v_fetched_count > v_page_size then v_next_cursor else null end
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 9. Owner alignment & internal helper privilege grants
-- -----------------------------------------------------------------------------
do $align_salary_advance_worker_history_owners$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_proc_owner_oid oid;
  v_fn pg_catalog.regprocedure;
  v_owner name;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entries'::pg_catalog.regclass;

  for v_fn, v_proc_owner_oid in
    select p.oid::pg_catalog.regprocedure, p.proowner
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'salary_advance%'
  loop
    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_base_owner);
    end if;
  end loop;

  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and p.proname like 'salary_advance%'
  loop
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_canonical_national_id(text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_is_canonical_national_id(text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_vietqr_bank_display_name(text) to %I',
      v_owner
    );
  end loop;
end;
$align_salary_advance_worker_history_owners$;

-- -----------------------------------------------------------------------------
-- 10. Strict function ACLs (`PUBLIC`, `anon`, `authenticated`, `service_role`)
-- -----------------------------------------------------------------------------
revoke all on function
  public.salary_advance__internal_worker_recruiter_info(uuid),
  public.salary_advance__internal_evaluate_worker(uuid),
  public.salary_advance__internal_worker_30d_summary(public.salary_advance_requests, jsonb, uuid),
  public.salary_advance__internal_project_request_summary(public.salary_advance_requests, jsonb, uuid),
  public.salary_advance__internal_build_request_detail(public.salary_advance_requests, jsonb, uuid)
from public, anon, authenticated, service_role;

revoke all on function
  public.salary_advance_list_project_workers(uuid, uuid, text, text, text, integer),
  public.salary_advance_create_request(uuid, uuid, text, uuid, text, text, text, text, text),
  public.salary_advance_list_worker_history(uuid, uuid, uuid, text, text, text, text, text, integer)
from public, anon, authenticated, service_role;

grant execute on function
  public.salary_advance_list_project_workers(uuid, uuid, text, text, text, integer),
  public.salary_advance_create_request(uuid, uuid, text, uuid, text, text, text, text, text),
  public.salary_advance_list_worker_history(uuid, uuid, uuid, text, text, text, text, text, integer)
to service_role;

commit;
