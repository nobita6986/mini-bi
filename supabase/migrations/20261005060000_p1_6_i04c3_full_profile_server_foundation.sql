begin;

alter table public.direct_entries
  add column general_note text
  check (general_note is null or length(btrim(general_note)) between 1 and 4000);

create or replace function public.direct_entry_valid_worker_details(p_worker jsonb)
returns boolean
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  v_key text;
  v_field jsonb;
  v_value jsonb;
  v_state text;
  v_date text;
  v_dob text;
  v_issued_at text;
begin
  if jsonb_typeof(p_worker) <> 'object'
     or p_worker - array[
       'display_name','date_of_birth','national_id','address','phone','gender',
       'national_id_issued_at','national_id_issued_place'
     ] <> '{}'::jsonb
     or not (p_worker ?& array[
       'display_name','date_of_birth','national_id','address','phone'
     ])
     or jsonb_typeof(p_worker->'display_name') <> 'string'
     or length(btrim(p_worker->>'display_name')) not between 1 and 256 then
    return false;
  end if;

  foreach v_key in array array[
    'date_of_birth','national_id','address','phone','gender',
    'national_id_issued_at','national_id_issued_place'
  ] loop
    if not (p_worker ? v_key) then
      continue;
    end if;
    v_field := p_worker->v_key;
    if jsonb_typeof(v_field) <> 'object'
       or v_field - array['state','value'] <> '{}'::jsonb
       or not (v_field ? 'state') then
      return false;
    end if;
    v_state := v_field->>'state';
    if v_state in ('omitted','unknown','intentionally_blank') then
      if v_field ? 'value' or (v_key = 'gender' and v_state = 'intentionally_blank') then
        return false;
      end if;
      continue;
    end if;
    if v_state <> 'provided' or not (v_field ? 'value')
       or jsonb_typeof(v_field->'value') <> 'string' then
      return false;
    end if;
    v_value := v_field->'value';
    if v_key = 'gender' then
      if v_value#>>'{}' not in ('MALE','FEMALE','OTHER') then
        return false;
      end if;
    elsif v_key in ('date_of_birth','national_id_issued_at') then
      v_date := v_value#>>'{}';
      if v_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        return false;
      end if;
      begin
        if to_char(to_date(v_date, 'YYYY-MM-DD'), 'YYYY-MM-DD') <> v_date then
          return false;
        end if;
      exception when others then
        return false;
      end;
      if v_key = 'date_of_birth' then
        v_dob := v_date;
      else
        v_issued_at := v_date;
      end if;
    elsif v_key = 'national_id' then
      v_date := v_value#>>'{}';
      if v_date !~ '^[0-9]+$' or length(v_date) not in (9,12) then
        return false;
      end if;
    elsif v_key = 'national_id_issued_place' then
      if length(btrim(v_value#>>'{}')) not between 1 and 256 then
        return false;
      end if;
    elsif v_key = 'address' and length(v_value#>>'{}') > 1024 then
      return false;
    elsif v_key = 'phone' and length(v_value#>>'{}') > 64 then
      return false;
    end if;
  end loop;

  if (v_dob is not null and v_dob > to_char(public.direct_entry_authorization_date(), 'YYYY-MM-DD'))
     or (v_issued_at is not null
       and v_issued_at > to_char(public.direct_entry_authorization_date(), 'YYYY-MM-DD'))
     or (v_dob is not null and v_issued_at is not null and v_issued_at < v_dob) then
    return false;
  end if;
  return true;
end;
$$;

revoke all on function public.direct_entry_valid_worker_details(jsonb)
  from public, anon, authenticated, service_role;

create unique index direct_entries_employee_code_lower_uidx
  on public.direct_entries (lower(employee_code));
create index direct_entries_worker_display_name_lower_idx
  on public.direct_entries (lower(btrim(worker_details->>'display_name')));
create unique index direct_entries_worker_national_id_uidx
  on public.direct_entries (btrim(worker_details->'national_id'->>'value'))
  where worker_details->'national_id'->>'state' = 'provided';

create or replace function public.direct_entry_entry_snapshot(p_entry_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'entry_id', e.entry_id,
    'submission_id', e.submission_id,
    'candidate_id', e.candidate_id,
    'created_by_user_id', e.created_by_user_id,
    'project_id', e.project_id,
    'first_work_date', e.first_work_date,
    'employee_code', e.employee_code,
    'worker_details', jsonb_build_object(
      'present', e.worker_details is not null and e.worker_details <> '{}'::jsonb
    ),
    'general_note', jsonb_build_object('present', e.general_note is not null),
    'recruiter_id', e.recruiter_id,
    'team_id', e.team_id,
    'provider_type', e.provider_type,
    'labor_type', e.labor_type,
    'version', e.version,
    'deleted_at', e.deleted_at,
    'employment_status', (
      select jsonb_build_object(
        'status', st.status, 'effective_date', st.effective_date, 'version', st.version
      )
        from public.direct_entry_employment_status_events st
       where st.entry_id = e.entry_id
       order by st.version desc
       limit 1
    ),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'document_id', d.document_id, 'document_type', d.document_type,
        'version', d.version, 'upload_status', latest.upload_status,
        'scan_status', latest.scan_status, 'validation_status', latest.validation_status,
        'updated_at', latest.created_at
      ) order by d.document_type, d.version)
        from public.direct_entry_document_versions d
        join lateral (
          select ev.upload_status, ev.scan_status, ev.validation_status, ev.created_at
            from public.direct_entry_document_events ev
           where ev.document_id = d.document_id
           order by ev.version desc
           limit 1
        ) latest on true
       where d.candidate_id = e.candidate_id
    ), '[]'::jsonb),
    'payment', case when p.entry_id is null then null else jsonb_build_object(
      'state', p.state, 'version', p.version
    ) end
  )
  from public.direct_entries e
  left join public.direct_entry_payments p on p.entry_id = e.entry_id
  where e.entry_id = p_entry_id
$$;

create or replace function public.direct_entry_read_projection(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_scope text;
  v_result jsonb;
  v_pii boolean;
  v_payment boolean;
  v_documents boolean;
begin
  select * into v_entry from public.direct_entries
   where entry_id = p_entry_id and deleted_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_assert_draft_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date
  );
  v_pii := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id and g.capability = 'pii_view'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  );
  v_payment := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id and g.capability = 'payment_view'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  );
  v_documents := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id and g.capability = 'document_view'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  );
  v_result := jsonb_build_object(
    'entry_id', v_entry.entry_id, 'submission_id', v_entry.submission_id,
    'project_id', v_entry.project_id, 'first_work_date', v_entry.first_work_date,
    'employee_code', v_entry.employee_code,
    'worker_details', case when v_pii then v_entry.worker_details else jsonb_build_object(
      'display_name', jsonb_build_object('present', v_entry.worker_details ? 'display_name'),
      'gender', jsonb_build_object('state', v_entry.worker_details->'gender'->>'state'),
      'date_of_birth', jsonb_build_object('state', v_entry.worker_details->'date_of_birth'->>'state'),
      'national_id', jsonb_build_object('state', v_entry.worker_details->'national_id'->>'state'),
      'national_id_issued_at', jsonb_build_object(
        'state', v_entry.worker_details->'national_id_issued_at'->>'state'
      ),
      'national_id_issued_place', jsonb_build_object(
        'state', v_entry.worker_details->'national_id_issued_place'->>'state'
      ),
      'address', jsonb_build_object('state', v_entry.worker_details->'address'->>'state'),
      'phone', jsonb_build_object('state', v_entry.worker_details->'phone'->>'state')
    ) end,
    'general_note', case when v_entry.general_note is null then null
      when v_pii then to_jsonb(v_entry.general_note)
      else jsonb_build_object('present', true) end,
    'recruiter_id', v_entry.recruiter_id, 'team_id', v_entry.team_id,
    'provider_type', v_entry.provider_type, 'labor_type', v_entry.labor_type,
    'version', v_entry.version, 'scope_kind', v_scope,
    'payment', (
      select case when v_payment then jsonb_build_object(
        'state', p.state, 'account_number', p.account_number, 'bank_id', p.bank_id,
        'account_holder_name', p.account_holder_name, 'version', p.version
      ) else jsonb_build_object(
        'state', p.state,
        'account_number', case when p.account_number is null then null
          else repeat('•', greatest(length(p.account_number) - 4, 0)) ||
            right(p.account_number, 4) end,
        'version', p.version
      ) end
        from public.direct_entry_payments p
       where p.entry_id = p_entry_id
    ),
    'employment_status', (
      select jsonb_build_object(
        'status', st.status, 'effective_date', st.effective_date, 'version', st.version
      )
        from public.direct_entry_employment_status_events st
       where st.entry_id = p_entry_id
       order by st.version desc
       limit 1
    ),
    'documents', case when v_documents then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'document_id', d.document_id, 'document_type', d.document_type,
        'version', d.version, 'size_bytes', d.size_bytes, 'mime_type', d.mime_type,
        'upload_status', d.upload_status, 'scan_status', d.scan_status
      ) order by d.document_type, d.version), '[]'::jsonb)
        from public.direct_entry_current_documents d
       where d.candidate_id = v_entry.candidate_id
    ) else '[]'::jsonb end
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_create_full_profile_batch(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_contract_version text,
  p_rows jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_auth_date date := public.direct_entry_authorization_date();
  v_row jsonb;
  v_worker_input jsonb;
  v_worker_details jsonb;
  v_payment jsonb;
  v_employment jsonb;
  v_note jsonb;
  v_state text;
  v_project_id text;
  v_recruiter_id uuid;
  v_first_work_date date;
  v_employee_code text;
  v_labor_type text;
  v_display_name text;
  v_general_note text;
  v_payment_state text;
  v_account_number text;
  v_bank_id text;
  v_account_holder_name text;
  v_status text;
  v_leave_date date;
  v_leave_reason_text text;
  v_provider_type text;
  v_team_id uuid;
  v_count integer;
  v_submission_id uuid := gen_random_uuid();
  v_candidate_id uuid;
  v_entry_id uuid;
  v_reason_id uuid;
  v_revision_id uuid;
  v_submission_revision_id uuid;
  v_entry_ids jsonb := '[]'::jsonb;
  v_codes text[] := '{}';
  v_national_ids text[] := '{}';
  v_national_id text;
  v_has_payment boolean := false;
  v_has_status boolean := false;
  v_prior jsonb;
  v_hash text;
  v_result jsonb;
begin
  if p_contract_version is distinct from 'worker-profile/1.0' then
    raise exception 'CONTRACT_VERSION_UNSUPPORTED' using errcode = '22023';
  end if;
  if p_idempotency_key is null
     or p_idempotency_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) not between 1 and 100 then
    raise exception 'BATCH_INVALID' using errcode = '22023';
  end if;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) <> 'object'
       or v_row - array[
         'project_id','first_work_date','employee_code','recruiter_id','labor_type',
         'display_name','worker_details','general_note','payment','employment'
       ] <> '{}'::jsonb then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    if v_row ? 'payment'
       and coalesce(v_row->'payment'->>'state', 'omitted') <> 'omitted' then
      v_has_payment := true;
    end if;
    if v_row ? 'employment' and v_row->'employment' ? 'initial_status' then
      v_has_status := true;
    end if;
  end loop;

  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'entry_create');
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'submission_create');
  if v_has_payment then
    perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'payment_view');
    perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'payment_edit');
  end if;
  if v_has_status then
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'employment_status.apply'
    );
  end if;

  v_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'contract_version', p_contract_version, 'rows', p_rows
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'full_profile_batch_create', p_idempotency_key, v_hash
  );
  if v_prior is not null then
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  insert into public.direct_entry_submissions (submission_id, created_by_user_id)
    values (v_submission_id, p_app_user_id);
  v_reason_id := public.direct_entry_reason(p_app_user_id, 'Initial full-profile batch creation');

  for v_row in select value from jsonb_array_elements(p_rows) loop
    if v_row ? 'worker_details' and jsonb_typeof(v_row->'worker_details') <> 'object' then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    v_worker_input := coalesce(v_row->'worker_details', '{}'::jsonb);
    if v_worker_input - array[
      'gender','date_of_birth','national_id','national_id_issued_at',
      'national_id_issued_place','address','phone'
    ] <> '{}'::jsonb then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;

    v_project_id := v_row->>'project_id';
    v_recruiter_id := case
      when coalesce(v_row->>'recruiter_id','') ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (v_row->>'recruiter_id')::uuid else null end;
    v_employee_code := v_row->>'employee_code';
    v_labor_type := v_row->>'labor_type';
    v_display_name := v_row->>'display_name';
    begin
      if coalesce(v_row->>'first_work_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'invalid date';
      end if;
      v_first_work_date := (v_row->>'first_work_date')::date;
      if to_char(v_first_work_date, 'YYYY-MM-DD') <> v_row->>'first_work_date' then
        raise exception 'invalid date';
      end if;
    exception when others then
      raise exception 'PROFILE_DATE_INVALID' using errcode = '22023';
    end;

    if v_project_id is null or v_project_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
       or not exists (
         select 1 from public.direct_entry_projects p
          where p.project_id = v_project_id and p.active
       ) then
      raise exception 'PROJECT_NOT_ACTIVE' using errcode = '22023';
    end if;
    if v_recruiter_id is null or not exists (
      select 1 from public.recruiters r
       where r.recruiter_id = v_recruiter_id and r.active
    ) then
      raise exception 'RECRUITER_NOT_ACTIVE' using errcode = '22023';
    end if;
    if v_employee_code is null then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    elsif v_employee_code ~ '^hrp-[0-9]{4}-[0-9]+$'
       and v_employee_code !~ '^hrp-[0-9]{4}-[0-9]{6}$' then
      raise exception 'EMPLOYEE_CODE_LEGACY_QUARANTINE' using errcode = '22023';
    elsif v_employee_code !~ '^hrp-[0-9]{4}-[0-9]{6}$' then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    elsif substring(v_employee_code from 5 for 4) <> to_char(v_first_work_date, 'YYYY') then
      raise exception 'EMPLOYEE_CODE_YEAR' using errcode = '22023';
    end if;
    if v_employee_code = any(v_codes) then
      raise exception 'EMPLOYEE_CODE_DUPLICATE' using errcode = '22023';
    end if;
    v_codes := array_append(v_codes, v_employee_code);

    if v_display_name is null or length(btrim(v_display_name)) not between 1 and 256
       or v_labor_type not in ('TEMPORARY','PERMANENT') then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    v_worker_details := jsonb_build_object(
      'display_name', v_display_name,
      'gender', coalesce(v_worker_input->'gender', '{"state":"omitted"}'::jsonb),
      'date_of_birth', coalesce(v_worker_input->'date_of_birth', '{"state":"omitted"}'::jsonb),
      'national_id', coalesce(v_worker_input->'national_id', '{"state":"omitted"}'::jsonb),
      'national_id_issued_at', coalesce(v_worker_input->'national_id_issued_at', '{"state":"omitted"}'::jsonb),
      'national_id_issued_place', coalesce(v_worker_input->'national_id_issued_place', '{"state":"omitted"}'::jsonb),
      'address', coalesce(v_worker_input->'address', '{"state":"omitted"}'::jsonb),
      'phone', coalesce(v_worker_input->'phone', '{"state":"omitted"}'::jsonb)
    );
    if not public.direct_entry_valid_worker_details(v_worker_details) then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    v_national_id := case
      when v_worker_details->'national_id'->>'state' = 'provided'
      then v_worker_details->'national_id'->>'value'
      else null
    end;
    if v_national_id is not null then
      if v_national_id = any(v_national_ids) then
        raise exception 'NATIONAL_ID_DUPLICATE' using errcode = '22023';
      end if;
      if exists (
        select 1 from public.direct_entries e
         where btrim(e.worker_details->'national_id'->>'value') = btrim(v_national_id)
           and e.worker_details->'national_id'->>'state' = 'provided'
      ) then
        raise exception 'NATIONAL_ID_DUPLICATE' using errcode = '23505';
      end if;
      v_national_ids := array_append(v_national_ids, v_national_id);
    end if;

    if v_worker_details->'date_of_birth'->>'state' = 'provided'
       and v_worker_details->'date_of_birth'->>'value' > to_char(v_auth_date, 'YYYY-MM-DD') then
      raise exception 'PROFILE_DATE_INVALID' using errcode = '22023';
    end if;
    if v_worker_details->'national_id_issued_at'->>'state' = 'provided' then
      if v_worker_details->'national_id_issued_at'->>'value' > to_char(v_auth_date, 'YYYY-MM-DD')
         or (v_worker_details->'date_of_birth'->>'state' = 'provided'
           and v_worker_details->'national_id_issued_at'->>'value'
             < v_worker_details->'date_of_birth'->>'value') then
        raise exception 'PROFILE_DATE_INVALID' using errcode = '22023';
      end if;
    end if;

    select count(*) into v_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id and g.scope_kind = 'own'
       and g.valid_from <= v_first_work_date
       and (g.valid_to is null or v_first_work_date < g.valid_to);
    if v_count <> 1 then
      raise exception 'entry creation own scope denied' using errcode = '42501';
    end if;
    select count(*), min(m.provider_type) into v_count, v_provider_type
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and m.valid_from <= v_first_work_date
       and (m.valid_to is null or v_first_work_date < m.valid_to);
    if v_count <> 1 then
      raise exception 'RECRUITER_MEMBERSHIP_INVALID' using errcode = '22023';
    end if;
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id
       and m.valid_from <= v_first_work_date
       and (m.valid_to is null or v_first_work_date < m.valid_to);
    if v_count <> 1 then
      raise exception 'RECRUITER_MEMBERSHIP_INVALID' using errcode = '22023';
    end if;

    v_note := coalesce(v_row->'general_note', '{"state":"omitted"}'::jsonb);
    if jsonb_typeof(v_note) <> 'object'
       or v_note - array['state','value'] <> '{}'::jsonb
       or not (v_note ? 'state') then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    v_state := v_note->>'state';
    if v_state = 'provided' then
      v_general_note := v_note->>'value';
      if jsonb_typeof(v_note->'value') <> 'string'
         or not (v_note ? 'value')
         or length(btrim(v_general_note)) not between 1 and 4000 then
        raise exception 'GENERAL_NOTE_TOO_LONG' using errcode = '22023';
      end if;
    elsif v_state = 'omitted' then
      if v_note ? 'value' then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
      v_general_note := null;
    else
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;

    v_payment := nullif(v_row->'payment', 'null'::jsonb);
    v_payment_state := null;
    v_account_number := null;
    v_bank_id := null;
    v_account_holder_name := null;
    if v_payment is not null then
      if jsonb_typeof(v_payment) <> 'object'
         or v_payment - array['state','account_number','bank_id','account_holder_name'] <> '{}'::jsonb
         or not (v_payment ? 'state') then
        raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
      end if;
      v_payment_state := v_payment->>'state';
      if v_payment_state not in ('omitted','unknown','intentionally_blank','provided') then
        raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
      end if;
      if v_payment_state = 'provided' then
        v_account_number := v_payment->>'account_number';
        v_bank_id := v_payment->>'bank_id';
        v_account_holder_name := v_payment->>'account_holder_name';
        if jsonb_typeof(v_payment->'account_number') <> 'string'
           or length(v_account_number) not between 1 and 64
           or v_account_number ~ '[[:cntrl:]]'
           or jsonb_typeof(v_payment->'bank_id') <> 'string'
           or v_bank_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
           or jsonb_typeof(v_payment->'account_holder_name') <> 'string'
           or length(btrim(v_account_holder_name)) not between 1 and 256 then
          raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
        end if;
        if not exists (
          select 1 from public.direct_entry_banks b
           where b.bank_id = v_bank_id and b.active
        ) then
          raise exception 'BANK_NOT_ACTIVE' using errcode = '22023';
        end if;
      elsif v_payment ?| array['account_number','bank_id','account_holder_name'] then
        raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
      end if;
    end if;

    v_employment := nullif(v_row->'employment', 'null'::jsonb);
    v_status := null;
    v_leave_date := null;
    v_leave_reason_text := null;
    if v_employment is not null then
      if jsonb_typeof(v_employment) <> 'object'
         or v_employment - array['initial_status','leave_date','leave_reason_text'] <> '{}'::jsonb
         or not (v_employment ? 'initial_status') then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
      v_status := v_employment->>'initial_status';
      if v_status not in ('UNCONFIRMED','ON','OFF')
         or v_first_work_date >= v_auth_date then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
      if v_status = 'OFF' then
        begin
          if coalesce(v_employment->>'leave_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
            raise exception 'invalid date';
          end if;
          v_leave_date := (v_employment->>'leave_date')::date;
          if to_char(v_leave_date, 'YYYY-MM-DD') <> v_employment->>'leave_date' then
            raise exception 'invalid date';
          end if;
        exception when others then
          raise exception 'OFF_REQUIRES_DATE_AND_REASON' using errcode = '22023';
        end;
        v_leave_reason_text := v_employment->>'leave_reason_text';
        if v_leave_date < v_first_work_date or v_leave_date > v_auth_date
           or v_leave_reason_text is null
           or length(btrim(v_leave_reason_text)) not between 1 and 4000 then
          raise exception 'OFF_REQUIRES_DATE_AND_REASON' using errcode = '22023';
        end if;
      elsif v_employment ? 'leave_date' or v_employment ? 'leave_reason_text' then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
    end if;

    insert into public.direct_entry_candidates default values
      returning candidate_id into v_candidate_id;
    insert into public.direct_entries (
      submission_id, candidate_id, created_by_user_id, project_id, first_work_date,
      employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type,
      general_note
    ) values (
      v_submission_id, v_candidate_id, p_app_user_id, v_project_id, v_first_work_date,
      v_employee_code, v_worker_details, v_recruiter_id, v_team_id, v_provider_type,
      v_labor_type, v_general_note
    ) returning entry_id into v_entry_id;

    insert into public.direct_entry_employment_status_events (
      entry_id, status, effective_date, version, actor_user_id, reason_id
    ) values (
      v_entry_id, 'UNCONFIRMED', v_first_work_date, 1, p_app_user_id, v_reason_id
    );
    if v_status in ('ON','OFF') then
      insert into public.direct_entry_employment_status_events (
        entry_id, status, effective_date, leave_date, leave_reason_text,
        version, actor_user_id, reason_id
      ) values (
        v_entry_id, v_status,
        case when v_status = 'OFF' then v_leave_date else v_first_work_date end,
        v_leave_date, v_leave_reason_text, 2, p_app_user_id, v_reason_id
      );
    end if;
    if v_payment_state is not null and v_payment_state <> 'omitted' then
      insert into public.direct_entry_payments (
        entry_id, state, account_number, bank_id, account_holder_name
      ) values (
        v_entry_id, v_payment_state, v_account_number, v_bank_id, v_account_holder_name
      );
    end if;

    v_revision_id := public.direct_entry_write_revision(
      v_entry_id, p_app_user_id, v_reason_id, null,
      public.direct_entry_entry_snapshot(v_entry_id), 1
    );
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, outcome, reason_id, revision_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'entry_create', 'entry_create',
      v_entry_id::text, 'own', 'APPLIED', v_reason_id, v_revision_id,
      array['entry_created','worker_details','general_note']
        || case when v_payment_state is not null and v_payment_state <> 'omitted'
             then array['payment']::text[] else '{}'::text[] end
        || case when v_status is not null
             then array['employment_status']::text[] else '{}'::text[] end
    );
    v_entry_ids := v_entry_ids || jsonb_build_array(v_entry_id);
  end loop;

  v_submission_revision_id := public.direct_entry_write_submission_revision(
    v_submission_id, p_app_user_id, v_reason_id, null,
    jsonb_build_object('state','DRAFT','version',1,'entry_count',jsonb_array_length(p_rows)), 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'full_profile_batch_create', 'entry_create',
    v_submission_id::text, 'own', 'APPLIED', v_reason_id,
    v_submission_revision_id, array['submission_created','entries_created']
  );
  v_result := jsonb_build_object(
    'submission_id', v_submission_id,
    'state', 'DRAFT',
    'version', 1,
    'entry_ids', v_entry_ids,
    'replayed', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'full_profile_batch_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

revoke all on function public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)
  to service_role;
revoke all on function public.direct_entry_read_projection(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_read_projection(uuid,uuid,uuid)
  to service_role;

commit;
