-- =============================================================================
-- Hotfix: Salary Advance Actor Display Name, Payment Method (`CASH` / `BANK_TRANSFER`),
--         Self-Owned Bank Account Verification, Transfer Receipt Evidence &
--         Worker Eligibility Guards (`/salary-advances`)
--
-- Scope:
--   1. Unified actor display name resolution (`salary_advance__internal_actor_display_name`):
--      - Priority 1: Verified current linked recruitment staff name
--        (`public.direct_entry_app_user_recruiter_links` + `public.recruiters`).
--      - Priority 2: Non-UUID `public.direct_entry_app_users.display_name`.
--      - Priority 3: Non-UUID `login_id` from `auth.users` email local-part.
--      - Priority 4: Fallback `'Chưa cập nhật tên'` (never raw UUID).
--   2. Mandatory payment method (`payment_method`: `'CASH'` | `'BANK_TRANSFER'`):
--      - Historical/existing requests default to `'CASH'` and preserve full
--        cash-handover photo evidence & 4-way worker portrait review lock.
--      - `'BANK_TRANSFER'` requires a complete self-owned bank account on the
--        worker profile (`public.direct_entry_payments`), where normalized
--        `account_holder_name` matches normalized worker `display_name`.
--      - Captures minimal destination snapshot (`payment_destination_snapshot`)
--        on the request so subsequent profile bank edits do not break
--        reconciliation of existing requests.
--      - Reviews `'BANK_TRANSFER'` evidence as `'BANK_TRANSFER_RECEIPT'`
--        without worker portrait face-comparison lock, while keeping `'CASH'`
--        strictly locked to `'CASH_HANDOVER_PHOTO'` + 4-way worker portrait.
--   3. Worker eligibility blocking (`salary_advance__internal_evaluate_worker`):
--      - Blocks workers whose current employment status is `'OFF'` or
--        `'UNCONFIRMED'` (must be `'ON'`).
--      - Blocks workers currently `'ON'` in >= 2 distinct projects.
--      - Blocks workers belonging to a duplicate CCCD group per the canonical
--        `public.direct_entry_duplicate_cccd_report` cluster logic.
--      - Enforced in worker picker (`salary_advance_list_project_workers`),
--        request creation (`salary_advance_create_request`), and accountant
--        approval (`salary_advance_transition_request` on `'APPROVE'`).
--      - Never exposes raw CCCD to the client and never auto-deletes or
--        auto-cancels existing requests.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Schema extensions & constraints on `salary_advance_requests` and `salary_advance_events`.
-- -----------------------------------------------------------------------------
alter table public.salary_advance_requests
  add column if not exists payment_method text not null default 'CASH',
  add column if not exists payment_destination_snapshot jsonb null;

alter table public.salary_advance_requests
  drop constraint if exists salary_advance_requests_payment_method_chk;

alter table public.salary_advance_requests
  add constraint salary_advance_requests_payment_method_chk check (
    payment_method in ('CASH', 'BANK_TRANSFER')
  );

alter table public.salary_advance_requests
  drop constraint if exists salary_advance_requests_payment_destination_chk;

alter table public.salary_advance_requests
  add constraint salary_advance_requests_payment_destination_chk check (
    (
      payment_method = 'CASH'
      and payment_destination_snapshot is null
    )
    or (
      payment_method = 'BANK_TRANSFER'
      and payment_destination_snapshot is not null
      and pg_catalog.jsonb_typeof(payment_destination_snapshot) = 'object'
      and nullif(pg_catalog.btrim(coalesce(payment_destination_snapshot->>'institution_name', '')), '') is not null
      and nullif(pg_catalog.btrim(coalesce(payment_destination_snapshot->>'account_number', '')), '') is not null
      and nullif(pg_catalog.btrim(coalesce(payment_destination_snapshot->>'account_number_masked', '')), '') is not null
      and nullif(pg_catalog.btrim(coalesce(payment_destination_snapshot->>'account_holder_name', '')), '') is not null
      and nullif(pg_catalog.btrim(coalesce(payment_destination_snapshot->>'normalized_holder_name', '')), '') is not null
    )
  );

alter table public.salary_advance_requests
  drop constraint if exists salary_advance_requests_reviewed_portrait_chk;

alter table public.salary_advance_requests
  add constraint salary_advance_requests_reviewed_portrait_chk check (
    (
      evidence_review_state = 'REVIEWED'
      and evidence_reviewed_by_user_id is not null
      and evidence_reviewed_at is not null
      and (
        (
          payment_method = 'CASH'
          and reviewed_worker_portrait_document_id is not null
          and reviewed_worker_portrait_version is not null
        )
        or (
          payment_method = 'BANK_TRANSFER'
          and reviewed_worker_portrait_document_id is null
          and reviewed_worker_portrait_version is null
        )
      )
    )
    or (
      evidence_review_state <> 'REVIEWED'
      and reviewed_worker_portrait_document_id is null
      and reviewed_worker_portrait_version is null
    )
  );

alter table public.salary_advance_events
  add column if not exists evidence_kind text null;

alter table public.salary_advance_events
  drop constraint if exists salary_advance_events_evidence_kind_chk;

alter table public.salary_advance_events
  add constraint salary_advance_events_evidence_kind_chk check (
    evidence_kind is null
    or evidence_kind in ('CASH_HANDOVER_PHOTO', 'BANK_TRANSFER_RECEIPT')
  );

alter table public.salary_advance_events
  drop constraint if exists salary_advance_events_evidence_payload_chk;

alter table public.salary_advance_events
  add constraint salary_advance_events_evidence_payload_chk check (
    (
      event_type = 'EVIDENCE_UPLOADED'
      and coalesce(evidence_kind, 'CASH_HANDOVER_PHOTO') in ('CASH_HANDOVER_PHOTO', 'BANK_TRANSFER_RECEIPT')
      and evidence_version is not null
      and evidence_storage_key is not null
      and evidence_mime_type is not null
      and evidence_size_bytes is not null
      and evidence_checksum_sha256 is not null
      and reviewed_worker_portrait_document_id is null
      and reviewed_worker_portrait_version is null
    )
    or (
      event_type = 'EVIDENCE_REVIEWED'
      and evidence_version is not null
      and evidence_storage_key is null
      and evidence_mime_type is null
      and evidence_size_bytes is null
      and evidence_checksum_sha256 is null
      and (
        (
          coalesce(evidence_kind, 'CASH_HANDOVER_PHOTO') = 'CASH_HANDOVER_PHOTO'
          and reviewed_worker_portrait_document_id is not null
          and reviewed_worker_portrait_version is not null
        )
        or (
          evidence_kind = 'BANK_TRANSFER_RECEIPT'
          and reviewed_worker_portrait_document_id is null
          and reviewed_worker_portrait_version is null
        )
      )
    )
    or (
      event_type = 'EVIDENCE_RETAKE_REQUESTED'
      and coalesce(evidence_kind, 'CASH_HANDOVER_PHOTO') in ('CASH_HANDOVER_PHOTO', 'BANK_TRANSFER_RECEIPT')
      and evidence_version is not null
      and evidence_storage_key is null
      and evidence_mime_type is null
      and evidence_size_bytes is null
      and evidence_checksum_sha256 is null
      and reviewed_worker_portrait_document_id is null
      and reviewed_worker_portrait_version is null
    )
    or (
      event_type not in ('EVIDENCE_UPLOADED', 'EVIDENCE_REVIEWED', 'EVIDENCE_RETAKE_REQUESTED')
      and evidence_kind is null
      and evidence_version is null
      and evidence_storage_key is null
      and evidence_mime_type is null
      and evidence_size_bytes is null
      and evidence_checksum_sha256 is null
      and reviewed_worker_portrait_document_id is null
      and reviewed_worker_portrait_version is null
    )
  );

-- -----------------------------------------------------------------------------
-- 2. Internal helpers: actor name, person name normalization & worker eligibility.
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance__internal_actor_display_name(
  p_user_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_name text;
begin
  if p_user_id is null then
    return 'Chưa cập nhật tên';
  end if;

  select coalesce(
           case
             when linked.display_name is not null
                  and linked.display_name !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               then linked.display_name
             else null
           end,
           case
             when nullif(pg_catalog.btrim(coalesce(u.display_name, '')), '') is not null
                  and pg_catalog.btrim(u.display_name) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               then pg_catalog.btrim(u.display_name)
             else null
           end,
           case
             when auth_login.login_id is not null
                  and auth_login.login_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               then auth_login.login_id
             else null
           end,
           'Chưa cập nhật tên'
         )
    into v_name
    from public.direct_entry_app_users u
    left join lateral (
      select nullif(pg_catalog.btrim(coalesce(r.display_name, '')), '') as display_name
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id
       where l.app_user_id = u.app_user_id
         and l.verified = true
         and l.is_current = true
       order by l.valid_from desc, l.link_id desc
       limit 1
    ) linked on true
    left join lateral (
      select pg_catalog.lower(
               nullif(
                 pg_catalog.btrim(
                   pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), '@', 1)
                 ),
                 ''
               )
             ) as login_id
        from auth.users au
       where au.id = u.auth_subject
       limit 1
    ) auth_login on true
   where u.app_user_id = p_user_id;

  return pg_catalog.left(coalesce(v_name, 'Chưa cập nhật tên'), 256);
end;
$function$;

create or replace function public.salary_advance__internal_normalize_person_name(
  p_raw text
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_norm text;
begin
  if p_raw is null then
    return '';
  end if;

  v_norm := pg_catalog.translate(
    p_raw,
    'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ' ||
    'ÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ',
    'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd' ||
    'AAAAAAAAAAAAAAAAAEEEEEEEEEEEIIIIIOOOOOOOOOOOOOOOOOUUUUUUUUUUUYYYYYD'
  );

  v_norm := pg_catalog.regexp_replace(v_norm, '[\u0300-\u036f]+', '', 'g');
  v_norm := pg_catalog.upper(v_norm);
  v_norm := pg_catalog.btrim(pg_catalog.regexp_replace(v_norm, '[^A-Z0-9]+', ' ', 'g'));
  return coalesce(v_norm, '');
end;
$function$;

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

  v_is_eligible := (
    v_latest_status = 'ON'
    and v_active_on_project_count < 2
    and not v_in_duplicate_cccd_group
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
      and v_institution_name is not null
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
        'is_self_owned', v_is_self_owned_bank,
        'payment_version', coalesce(v_pay.payment_version, 1)
      );
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'employment_status', v_latest_status,
    'active_on_project_count', v_active_on_project_count,
    'has_duplicate_cccd', v_in_duplicate_cccd_group,
    'is_eligible', v_is_eligible,
    'ineligible_reasons', v_reasons,
    'bank_transfer_eligible', v_is_self_owned_bank,
    'bank_ineligible_reason', v_bank_ineligible_reason,
    'bank_account', v_bank_json
  );
end;
$function$;

create or replace function public.salary_advance__internal_request_access(
  p_auth jsonb,
  p_app_user_id uuid,
  p_req public.salary_advance_requests
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_acct_info jsonb;
  v_acct_user_id uuid;
  v_is_creator_pm boolean := false;
  v_is_assigned_accountant boolean := false;
  v_is_supervisory boolean := false;
  v_can_view boolean := false;
begin
  v_today := (p_auth->>'authorization_date')::date;
  v_is_supervisory := coalesce((p_auth->>'is_supervisory_viewer')::boolean, false);

  v_is_creator_pm := (p_req.created_by_user_id = p_app_user_id)
    and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_req.project_id);

  v_acct_info := public.vendor_finance__internal_resolve_active_project_accountant(
    p_req.project_id,
    v_today
  );

  if coalesce((v_acct_info->>'accountant_active')::boolean, false) then
    v_acct_user_id := (v_acct_info->>'accountant_user_id')::uuid;
  end if;

  v_is_assigned_accountant := v_acct_user_id is not null
    and v_acct_user_id = p_app_user_id;

  v_can_view := v_is_creator_pm or v_is_assigned_accountant or v_is_supervisory;

  return pg_catalog.jsonb_build_object(
    'can_view', v_can_view,
    'is_creator_project_manager', v_is_creator_pm,
    'is_assigned_project_accountant', v_is_assigned_accountant,
    'is_supervisory_viewer', v_is_supervisory,
    'current_project_accountant', case
      when v_acct_user_id is not null then
        pg_catalog.jsonb_build_object(
          'app_user_id', v_acct_user_id,
          'display_name', public.salary_advance__internal_actor_display_name(v_acct_user_id)
        )
      else null
    end,
    'allowed_actions', pg_catalog.jsonb_build_object(
      'can_post_message', (
        (v_is_creator_pm or v_is_assigned_accountant)
        and p_req.request_state in ('OPEN', 'NEEDS_INFO', 'APPROVED')
      ),
      'can_provide_info', (
        v_is_creator_pm
        and p_req.request_state = 'NEEDS_INFO'
      ),
      'can_withdraw', (
        v_is_creator_pm
        and p_req.request_state in ('OPEN', 'NEEDS_INFO')
      ),
      'can_upload_evidence', (
        v_is_creator_pm
        and p_req.request_state = 'APPROVED'
        and p_req.evidence_review_state in ('NOT_UPLOADED', 'RETAKE_REQUIRED', 'PENDING_REVIEW')
      ),
      'can_request_info', (
        v_is_assigned_accountant
        and p_req.request_state = 'OPEN'
      ),
      'can_approve', (
        v_is_assigned_accountant
        and p_req.request_state in ('OPEN', 'NEEDS_INFO')
      ),
      'can_reject', (
        v_is_assigned_accountant
        and p_req.request_state in ('OPEN', 'NEEDS_INFO')
      ),
      'can_mark_handled_externally', (
        v_is_assigned_accountant
        and p_req.request_state = 'APPROVED'
      ),
      'can_review_evidence', (
        v_is_assigned_accountant
        and p_req.request_state = 'APPROVED'
        and p_req.evidence_review_state = 'PENDING_REVIEW'
        and p_req.current_evidence_version >= 1
      )
    )
  );
end;
$function$;

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
  v_default_evidence_kind text;
begin
  v_summary := public.salary_advance__internal_project_request_summary(p_req, p_auth, p_app_user_id);
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
    'evidence_versions', v_evidence_versions
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 3. Public `service_role`-only RPC updates (`public.salary_advance_*`).
-- -----------------------------------------------------------------------------

create or replace function public.salary_advance_get_actor_context(
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
  v_today date;
  v_managed_ids text[];
  v_accountant_ids text[];
  v_managed_projects jsonb := '[]'::jsonb;
  v_accountant_projects jsonb := '[]'::jsonb;
  v_supervisory_projects jsonb := '[]'::jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);
  if not coalesce((v_auth->>'allowed')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  v_today := (v_auth->>'authorization_date')::date;
  v_managed_ids := array(select pg_catalog.jsonb_array_elements_text(v_auth->'managed_project_ids'));
  v_accountant_ids := array(select pg_catalog.jsonb_array_elements_text(v_auth->'accountant_project_ids'));

  if coalesce(pg_catalog.array_length(v_managed_ids, 1), 0) > 0 then
    select coalesce(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'project_id', p.project_id,
                 'display_name', p.display_name,
                 'active', p.active,
                 'has_active_accountant', coalesce((acct.info->>'accountant_active')::boolean, false),
                 'accountant_user_id', case
                   when coalesce((acct.info->>'accountant_active')::boolean, false)
                     then (acct.info->>'accountant_user_id')::uuid
                   else null
                 end,
                 'accountant_display_name', case
                   when coalesce((acct.info->>'accountant_active')::boolean, false)
                     then public.salary_advance__internal_actor_display_name((acct.info->>'accountant_user_id')::uuid)
                   else null
                 end
               )
               order by p.project_id asc
             ),
             '[]'::jsonb
           )
      into v_managed_projects
      from public.direct_entry_projects p
      cross join lateral (
        select public.vendor_finance__internal_resolve_active_project_accountant(p.project_id, v_today) as info
      ) acct
     where p.project_id = any(v_managed_ids);
  end if;

  if coalesce(pg_catalog.array_length(v_accountant_ids, 1), 0) > 0 then
    select coalesce(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'project_id', p.project_id,
                 'display_name', p.display_name,
                 'active', p.active
               )
               order by p.project_id asc
             ),
             '[]'::jsonb
           )
      into v_accountant_projects
      from public.direct_entry_projects p
     where p.project_id = any(v_accountant_ids);
  end if;

  if coalesce((v_auth->>'is_supervisory_viewer')::boolean, false) then
    select coalesce(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'project_id', p.project_id,
                 'display_name', p.display_name,
                 'active', p.active
               )
               order by p.project_id asc
             ),
             '[]'::jsonb
           )
      into v_supervisory_projects
      from public.direct_entry_projects p;
  end if;

  return pg_catalog.jsonb_build_object(
    'app_user_id', p_app_user_id,
    'display_name', public.salary_advance__internal_actor_display_name(p_app_user_id),
    'is_project_manager', (v_auth->>'is_project_manager')::boolean,
    'is_project_accountant', (v_auth->>'is_project_accountant')::boolean,
    'is_supervisory_viewer', (v_auth->>'is_supervisory_viewer')::boolean,
    'is_full_admin', (v_auth->>'is_full_admin')::boolean,
    'is_bod', (v_auth->>'is_bod')::boolean,
    'managed_projects', v_managed_projects,
    'accountant_projects', v_accountant_projects,
    'supervisory_projects', v_supervisory_projects,
    'authorization_date', v_auth->>'authorization_date'
  );
end;
$function$;

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
      'institution_name', v_worker_eval->'bank_account'->>'institution_name',
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

create or replace function public.salary_advance_create_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_worker_entry_id uuid,
  p_requested_amount_vnd text,
  p_initial_content text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  return public.salary_advance_create_request(
    p_auth_subject,
    p_app_user_id,
    p_project_id,
    p_worker_entry_id,
    p_requested_amount_vnd,
    p_initial_content,
    p_idempotency_key,
    p_request_fingerprint,
    'CASH'
  );
end;
$function$;

create or replace function public.salary_advance_transition_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_action text,
  p_expected_version integer,
  p_message_text text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_action text;
  v_idem_action text;
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_is_pm boolean;
  v_is_acct boolean;
  v_actor_role text;
  v_worker_eval jsonb;
  v_note text;
  v_from_state text;
  v_to_state text;
  v_event_type text;
  v_next_seq integer;
  v_now timestamptz := now();
  v_detail jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  v_action := pg_catalog.upper(pg_catalog.btrim(coalesce(p_action, '')));
  v_idem_action := case v_action
    when 'REQUEST_INFO' then 'REQUEST_INFO'
    when 'PROVIDE_INFO' then 'PROVIDE_INFO'
    when 'APPROVE' then 'APPROVE_REQUEST'
    when 'REJECT' then 'REJECT_REQUEST'
    when 'WITHDRAW' then 'WITHDRAW_REQUEST'
    when 'MARK_HANDLED_EXTERNALLY' then 'MARK_HANDLED_EXTERNALLY'
    else null
  end;

  if v_idem_action is null then
    raise exception 'SALARY_ADVANCE_ACTION_INVALID'
      using errcode = '22023';
  end if;

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
    if v_existing_idem.action <> v_idem_action
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_request_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id
   for update;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  v_is_pm := coalesce((v_access->>'is_creator_project_manager')::boolean, false);
  v_is_acct := coalesce((v_access->>'is_assigned_project_accountant')::boolean, false);

  if v_action in ('REQUEST_INFO', 'APPROVE', 'REJECT', 'MARK_HANDLED_EXTERNALLY') then
    if not v_is_acct then
      raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
        using errcode = '42501';
    end if;
    v_actor_role := 'PROJECT_ACCOUNTANT';
  else
    if not v_is_pm then
      raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
        using errcode = '42501';
    end if;
    v_actor_role := 'PROJECT_MANAGER';
  end if;

  if v_req.version <> p_expected_version then
    raise exception 'SALARY_ADVANCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  v_from_state := v_req.request_state;

  if v_action = 'REQUEST_INFO' then
    if v_from_state <> 'OPEN' then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      2000,
      false,
      'SALARY_ADVANCE_MESSAGE_REQUIRED'
    );
    v_to_state := 'NEEDS_INFO';
    v_event_type := 'INFO_REQUESTED';

  elsif v_action = 'PROVIDE_INFO' then
    if v_from_state <> 'NEEDS_INFO' then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      2000,
      false,
      'SALARY_ADVANCE_MESSAGE_REQUIRED'
    );
    v_to_state := 'OPEN';
    v_event_type := 'INFO_PROVIDED';

  elsif v_action = 'APPROVE' then
    if v_from_state not in ('OPEN', 'NEEDS_INFO') then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;

    -- Re-verify worker eligibility at approval time without mutating/deleting the request
    v_worker_eval := public.salary_advance__internal_evaluate_worker(v_req.worker_entry_id);

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

    if coalesce(v_req.payment_method, 'CASH') = 'BANK_TRANSFER'
       and v_req.payment_destination_snapshot is null then
      raise exception 'SALARY_ADVANCE_BANK_ACCOUNT_MISSING'
        using errcode = 'PT409';
    end if;

    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      1000,
      true,
      'SALARY_ADVANCE_NOTE_INVALID'
    );
    v_to_state := 'APPROVED';
    v_event_type := 'REQUEST_APPROVED';

  elsif v_action = 'REJECT' then
    if v_from_state not in ('OPEN', 'NEEDS_INFO') then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      1000,
      false,
      'SALARY_ADVANCE_REASON_REQUIRED'
    );
    v_to_state := 'REJECTED';
    v_event_type := 'REQUEST_REJECTED';

  elsif v_action = 'WITHDRAW' then
    if v_from_state not in ('OPEN', 'NEEDS_INFO') then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      1000,
      true,
      'SALARY_ADVANCE_NOTE_INVALID'
    );
    v_to_state := 'WITHDRAWN';
    v_event_type := 'REQUEST_WITHDRAWN';

  elsif v_action = 'MARK_HANDLED_EXTERNALLY' then
    if v_from_state <> 'APPROVED' then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      1000,
      true,
      'SALARY_ADVANCE_NOTE_INVALID'
    );
    v_to_state := 'HANDLED_EXTERNALLY';
    v_event_type := 'HANDLED_EXTERNALLY_MARKED';
  end if;

  select coalesce(max(ev.event_seq), 0)::integer + 1
    into v_next_seq
    from public.salary_advance_events ev
   where ev.request_id = v_req.request_id;

  perform pg_catalog.set_config('salary_advance.write_marker', 'on', true);

  update public.salary_advance_requests
     set request_state = v_to_state,
         version = v_req.version + 1,
         decided_by_user_id = case
           when v_action in ('APPROVE', 'REJECT') then p_app_user_id
           else decided_by_user_id
         end,
         decided_at = case
           when v_action in ('APPROVE', 'REJECT') then v_now
           else decided_at
         end,
         decision_note = case
           when v_action in ('APPROVE', 'REJECT') then v_note
           else decision_note
         end,
         handled_externally_by_user_id = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then p_app_user_id
           else handled_externally_by_user_id
         end,
         handled_externally_at = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then v_now
           else handled_externally_at
         end,
         handled_externally_note = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then v_note
           else handled_externally_note
         end,
         withdrawn_by_user_id = case
           when v_action = 'WITHDRAW' then p_app_user_id
           else withdrawn_by_user_id
         end,
         withdrawn_at = case
           when v_action = 'WITHDRAW' then v_now
           else withdrawn_at
         end,
         withdrawn_note = case
           when v_action = 'WITHDRAW' then v_note
           else withdrawn_note
         end,
         pending_upload_id = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_id
         end,
         pending_upload_storage_key = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_storage_key
         end,
         pending_upload_mime_type = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_mime_type
         end,
         pending_upload_size_bytes = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_size_bytes
         end,
         pending_upload_checksum_sha256 = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_checksum_sha256
         end,
         pending_upload_caption_note = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_caption_note
         end,
         pending_upload_reserved_by_user_id = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_reserved_by_user_id
         end,
         pending_upload_expires_at = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_expires_at
         end,
         last_activity_at = v_now,
         last_actor_user_id = p_app_user_id,
         updated_at = v_now
   where request_id = v_req.request_id
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
    v_next_seq,
    v_event_type,
    p_app_user_id,
    v_actor_role,
    v_from_state,
    v_to_state,
    v_req.evidence_review_state,
    v_req.evidence_review_state,
    v_note,
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
    v_idem_action,
    v_fingerprint,
    v_detail,
    v_now
  );

  return v_detail || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

create or replace function public.salary_advance_finalize_evidence(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_upload_id uuid,
  p_expected_version integer,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_evidence_kind text;
  v_next_seq integer;
  v_next_ev_version integer;
  v_from_ev_state text;
  v_event_id uuid;
  v_now timestamptz := now();
  v_detail jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

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
    if v_existing_idem.action <> 'FINALIZE_EVIDENCE'
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_request_id is null or p_upload_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id
   for update;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  if not coalesce((v_access->>'is_creator_project_manager')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if v_req.request_state <> 'APPROVED'
     or v_req.evidence_review_state not in ('NOT_UPLOADED', 'RETAKE_REQUIRED', 'PENDING_REVIEW') then
    raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.version <> p_expected_version then
    raise exception 'SALARY_ADVANCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.pending_upload_id is null or v_req.pending_upload_id <> p_upload_id then
    raise exception 'SALARY_ADVANCE_UPLOAD_SUPERSEDED'
      using errcode = 'PT409';
  end if;

  if v_req.pending_upload_expires_at is null
     or v_req.pending_upload_expires_at <= clock_timestamp() then
    raise exception 'SALARY_ADVANCE_UPLOAD_EXPIRED'
      using errcode = 'PT409';
  end if;

  v_from_ev_state := v_req.evidence_review_state;
  v_next_ev_version := v_req.current_evidence_version + 1;
  v_evidence_kind := case
    when coalesce(v_req.payment_method, 'CASH') = 'BANK_TRANSFER' then 'BANK_TRANSFER_RECEIPT'
    else 'CASH_HANDOVER_PHOTO'
  end;

  select coalesce(max(ev.event_seq), 0)::integer + 1
    into v_next_seq
    from public.salary_advance_events ev
   where ev.request_id = v_req.request_id;

  perform pg_catalog.set_config('salary_advance.write_marker', 'on', true);

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
    evidence_kind,
    evidence_version,
    evidence_storage_key,
    evidence_mime_type,
    evidence_size_bytes,
    evidence_checksum_sha256,
    created_at
  ) values (
    v_req.request_id,
    v_next_seq,
    'EVIDENCE_UPLOADED',
    p_app_user_id,
    'PROJECT_MANAGER',
    v_req.request_state,
    'APPROVED',
    v_from_ev_state,
    'PENDING_REVIEW',
    v_req.pending_upload_caption_note,
    v_evidence_kind,
    v_next_ev_version,
    v_req.pending_upload_storage_key,
    v_req.pending_upload_mime_type,
    v_req.pending_upload_size_bytes,
    v_req.pending_upload_checksum_sha256,
    v_now
  )
  returning event_id into v_event_id;

  update public.salary_advance_requests
     set evidence_review_state = 'PENDING_REVIEW',
         current_evidence_version = v_next_ev_version,
         current_evidence_event_id = v_event_id,
         current_evidence_storage_key = v_req.pending_upload_storage_key,
         current_evidence_mime_type = v_req.pending_upload_mime_type,
         current_evidence_size_bytes = v_req.pending_upload_size_bytes,
         current_evidence_checksum_sha256 = v_req.pending_upload_checksum_sha256,
         current_evidence_uploaded_by_user_id = p_app_user_id,
         current_evidence_uploaded_at = v_now,
         evidence_reviewed_by_user_id = null,
         evidence_reviewed_at = null,
         evidence_review_note = null,
         reviewed_worker_portrait_document_id = null,
         reviewed_worker_portrait_version = null,
         pending_upload_id = null,
         pending_upload_storage_key = null,
         pending_upload_mime_type = null,
         pending_upload_size_bytes = null,
         pending_upload_checksum_sha256 = null,
         pending_upload_caption_note = null,
         pending_upload_reserved_by_user_id = null,
         pending_upload_expires_at = null,
         version = v_req.version + 1,
         last_activity_at = v_now,
         last_actor_user_id = p_app_user_id,
         updated_at = v_now
   where request_id = v_req.request_id
  returning * into v_req;

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
    'FINALIZE_EVIDENCE',
    v_fingerprint,
    v_detail,
    v_now
  );

  return v_detail || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

create or replace function public.salary_advance_review_evidence(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_evidence_version integer,
  p_decision text,
  p_expected_worker_portrait_document_id uuid,
  p_expected_worker_portrait_version integer,
  p_note text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_decision text;
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_payment_method text;
  v_evidence_kind text;
  v_entry public.direct_entries%rowtype;
  v_portrait jsonb;
  v_reviewed_portrait_doc_id uuid := null;
  v_reviewed_portrait_version integer := null;
  v_note text;
  v_next_seq integer;
  v_event_type text;
  v_now timestamptz := now();
  v_detail jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  v_decision := pg_catalog.upper(pg_catalog.btrim(coalesce(p_decision, '')));
  if v_decision not in ('REVIEWED', 'RETAKE_REQUIRED') then
    raise exception 'SALARY_ADVANCE_DECISION_INVALID'
      using errcode = '22023';
  end if;

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
    if v_existing_idem.action <> 'REVIEW_EVIDENCE'
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_request_id is null
     or p_expected_version is null
     or p_expected_version < 1
     or p_evidence_version is null
     or p_evidence_version < 1 then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  v_note := public.salary_advance__internal_validate_text(
    p_note,
    1,
    1000,
    true,
    'SALARY_ADVANCE_NOTE_INVALID'
  );

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id
   for update;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  if not coalesce((v_access->>'is_assigned_project_accountant')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if v_req.request_state <> 'APPROVED'
     or v_req.evidence_review_state <> 'PENDING_REVIEW'
     or v_req.current_evidence_version < 1 then
    raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.version <> p_expected_version then
    raise exception 'SALARY_ADVANCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.current_evidence_version <> p_evidence_version then
    raise exception 'SALARY_ADVANCE_EVIDENCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  v_payment_method := coalesce(v_req.payment_method, 'CASH');
  v_evidence_kind := case
    when v_payment_method = 'BANK_TRANSFER' then 'BANK_TRANSFER_RECEIPT'
    else 'CASH_HANDOVER_PHOTO'
  end;

  if v_payment_method = 'BANK_TRANSFER' then
    -- Transfer receipt review must never use worker portrait comparison lock
    if p_expected_worker_portrait_document_id is not null
       or p_expected_worker_portrait_version is not null then
      raise exception 'SALARY_ADVANCE_PORTRAIT_LOCK_INVALID'
        using errcode = '22023';
    end if;

    if v_req.payment_destination_snapshot is null then
      raise exception 'SALARY_ADVANCE_BANK_ACCOUNT_MISSING'
        using errcode = 'PT409';
    end if;
  end if;

  if v_decision = 'REVIEWED' then
    if v_payment_method = 'CASH' then
      if p_expected_worker_portrait_document_id is null
         or p_expected_worker_portrait_version is null
         or p_expected_worker_portrait_version < 1 then
        raise exception 'SALARY_ADVANCE_PORTRAIT_LOCK_INVALID'
          using errcode = '22023';
      end if;

      select e.*
        into v_entry
        from public.direct_entries e
       where e.entry_id = v_req.worker_entry_id;

      v_portrait := public.salary_advance__internal_resolve_worker_portrait(v_entry.candidate_id);
      if v_portrait is null then
        raise exception 'SALARY_ADVANCE_WORKER_PORTRAIT_MISSING'
          using errcode = 'PT409';
      end if;

      if (v_portrait->>'document_id')::uuid <> p_expected_worker_portrait_document_id
         or (v_portrait->>'version')::integer <> p_expected_worker_portrait_version then
        raise exception 'SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT'
          using errcode = 'PT409';
      end if;

      v_reviewed_portrait_doc_id := p_expected_worker_portrait_document_id;
      v_reviewed_portrait_version := p_expected_worker_portrait_version;
    end if;

    v_event_type := 'EVIDENCE_REVIEWED';
  else
    v_event_type := 'EVIDENCE_RETAKE_REQUESTED';
  end if;

  select coalesce(max(ev.event_seq), 0)::integer + 1
    into v_next_seq
    from public.salary_advance_events ev
   where ev.request_id = v_req.request_id;

  perform pg_catalog.set_config('salary_advance.write_marker', 'on', true);

  update public.salary_advance_requests
     set evidence_review_state = v_decision,
         evidence_reviewed_by_user_id = p_app_user_id,
         evidence_reviewed_at = v_now,
         evidence_review_note = v_note,
         reviewed_worker_portrait_document_id = v_reviewed_portrait_doc_id,
         reviewed_worker_portrait_version = v_reviewed_portrait_version,
         version = v_req.version + 1,
         last_activity_at = v_now,
         last_actor_user_id = p_app_user_id,
         updated_at = v_now
   where request_id = v_req.request_id
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
    evidence_kind,
    evidence_version,
    reviewed_worker_portrait_document_id,
    reviewed_worker_portrait_version,
    created_at
  ) values (
    v_req.request_id,
    v_next_seq,
    v_event_type,
    p_app_user_id,
    'PROJECT_ACCOUNTANT',
    'APPROVED',
    'APPROVED',
    'PENDING_REVIEW',
    v_decision,
    v_note,
    v_evidence_kind,
    v_req.current_evidence_version,
    v_reviewed_portrait_doc_id,
    v_reviewed_portrait_version,
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
    'REVIEW_EVIDENCE',
    v_fingerprint,
    v_detail,
    v_now
  );

  return v_detail || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Owner alignment & internal helper privilege grants.
-- -----------------------------------------------------------------------------
do $align_salary_advance_hf_owners$
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
  end loop;
end;
$align_salary_advance_hf_owners$;

-- -----------------------------------------------------------------------------
-- 5. Strict function ACLs (`PUBLIC`, `anon`, `authenticated`, `service_role`).
-- -----------------------------------------------------------------------------
revoke all on function
  public.salary_advance__internal_actor_display_name(uuid),
  public.salary_advance__internal_normalize_person_name(text),
  public.salary_advance__internal_evaluate_worker(uuid),
  public.salary_advance__internal_request_access(jsonb, uuid, public.salary_advance_requests),
  public.salary_advance__internal_project_request_summary(public.salary_advance_requests, jsonb, uuid),
  public.salary_advance__internal_build_request_detail(public.salary_advance_requests, jsonb, uuid)
from public, anon, authenticated, service_role;

revoke all on function
  public.salary_advance_get_actor_context(uuid, uuid),
  public.salary_advance_list_project_workers(uuid, uuid, text, text, text, integer),
  public.salary_advance_create_request(uuid, uuid, text, uuid, text, text, text, text),
  public.salary_advance_create_request(uuid, uuid, text, uuid, text, text, text, text, text),
  public.salary_advance_transition_request(uuid, uuid, uuid, text, integer, text, text, text),
  public.salary_advance_finalize_evidence(uuid, uuid, uuid, uuid, integer, text, text),
  public.salary_advance_review_evidence(uuid, uuid, uuid, integer, integer, text, uuid, integer, text, text, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.salary_advance_get_actor_context(uuid, uuid),
  public.salary_advance_list_project_workers(uuid, uuid, text, text, text, integer),
  public.salary_advance_create_request(uuid, uuid, text, uuid, text, text, text, text),
  public.salary_advance_create_request(uuid, uuid, text, uuid, text, text, text, text, text),
  public.salary_advance_transition_request(uuid, uuid, uuid, text, integer, text, text, text),
  public.salary_advance_finalize_evidence(uuid, uuid, uuid, uuid, integer, text, text),
  public.salary_advance_review_evidence(uuid, uuid, uuid, integer, integer, text, uuid, integer, text, text, text)
to service_role;

commit;
