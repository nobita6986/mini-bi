-- P1.6-W04-S04C-S03B3-R1 - Change policy security closure (forward-only).
--
-- DAY LA HARDENING TRUOC GO-LIVE, KHONG PHAI XU LY SU CO DU LIEU.
--
-- Pham vi (policy T0 da khoa, khong tu thay doi):
--   1. Decision authority: APPROVE va REJECT chi duoc phep khi actor co DU capability cho
--      TOAN BO item cua request (union, all-or-nothing, khong partial apply/audit/revision):
--        A. ENTRY_FIELD 5 truong non-PII : change_review
--        B. ENTRY_FIELD.worker_details  : change_review + pii_view
--        C. PAYMENT                     : change_review + payment_view + payment_edit
--        D. WORK_STATUS                 : change_review + employment_status.apply
--        E. DOCUMENT                    : change_review + document_view + document_upload
--      Self-review tiep tuc bi cam o DB (khong noi long).
--   2. Read projection: direct_entry_read_change_request tra projection toi thieu theo
--      capability server-side (FULL / MASKED / PRESENCE_ONLY / OMIT); khong tra raw
--      proposal roi cho UI tu che.
--   3. Revision snapshot: direct_entry_entry_snapshot redact CO DINH ngay luc ghi
--      (khong "redact theo viewer"), nen revision moi khong con raw PII/payment/free text.
--
-- Khong doi migration #1-#32 da apply. Khong doi table/schema. Khong them capability moi.
-- Khong cap EXECUTE cho helper noi bo. Khong deployment nao duoc thuc hien boi migration nay.
--
-- ROLLBACK (chay tay, thu tu nguoc): apply lai dinh nghia cu cua
--   public.direct_entry_decide_change_request + public.direct_entry_apply_change_item
--     (20261002170000_p1_6_direct_entry_foundation.sql),
--   public.direct_entry_entry_snapshot
--     (20261005000000_p1_6_w04_s04b_r2a_direct_upload.sql),
--   public.direct_entry_read_change_request
--     (20261005010000_p1_6_w04_s04c_change_request_reads.sql),
--   roi drop 4 helper moi:
--     drop function if exists public.direct_entry_change_request_proposal_projection(text, jsonb, boolean, boolean, boolean);
--     drop function if exists public.direct_entry_assert_change_request_capabilities(uuid, uuid, uuid);
--     drop function if exists public.direct_entry_change_request_required_capabilities(uuid);
--     drop function if exists public.direct_entry_has_capability(uuid, text);

-- ---------------------------------------------------------------------------
-- 1. Helper noi bo: capability con hieu luc cua mot app_user
-- ---------------------------------------------------------------------------
create or replace function public.direct_entry_has_capability(
  p_app_user_id uuid,
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p_app_user_id is not null
     and p_capability is not null
     and exists (
           select 1 from public.direct_entry_app_users u
            where u.app_user_id = p_app_user_id and u.enabled
         )
     and exists (
           select 1 from public.direct_entry_capability_grants g
            where g.app_user_id = p_app_user_id
              and g.capability = p_capability
              and g.valid_from <= public.direct_entry_authorization_date()
              and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
         );
$$;

-- ---------------------------------------------------------------------------
-- 2. Helper noi bo: capability bat buoc cho quyet dinh, SUY RA TU items (khong nhan tu client)
-- ---------------------------------------------------------------------------
create or replace function public.direct_entry_change_request_required_capabilities(
  p_request_id uuid
)
returns text[]
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select array(
    select distinct required.capability
      from (
        select 'change_review'::text as capability
        union all
        select case
                 when i.target_kind = 'PAYMENT' then 'payment_view'
                 when i.target_kind = 'WORK_STATUS' then 'employment_status.apply'
                 when i.target_kind = 'DOCUMENT' then 'document_view'
                 when i.target_kind = 'ENTRY_FIELD' and (i.proposal ? 'worker_details') then 'pii_view'
               end
          from public.direct_entry_change_request_items i
         where i.request_id = p_request_id
        union all
        select case
                 when i.target_kind = 'PAYMENT' then 'payment_edit'
                 when i.target_kind = 'DOCUMENT' then 'document_upload'
               end
          from public.direct_entry_change_request_items i
         where i.request_id = p_request_id
      ) required
     where required.capability is not null
     order by required.capability
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Helper noi bo: assert union capability cho ca APPROVE va REJECT
-- ---------------------------------------------------------------------------
create or replace function public.direct_entry_assert_change_request_capabilities(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_capability text;
begin
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'change_review');
  for v_capability in
    select capability
      from unnest(
        public.direct_entry_change_request_required_capabilities(p_request_id)
      ) as required(capability)
  loop
    if not public.direct_entry_has_capability(p_app_user_id, v_capability) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Helper noi bo: projection proposal theo capability (khong bao gio tra raw sensitive)
-- ---------------------------------------------------------------------------
-- ENTRY_FIELD : 5 truong non-PII FULL; worker_details PRESENCE_ONLY khi thieu pii_view, FULL khi co.
-- PAYMENT     : state FULL; thieu payment_view thi account_number MASKED last-4, bank_id/account_holder_name OMIT.
-- WORK_STATUS : status/effective_date FULL; leave_reason luon OMIT.
-- DOCUMENT    : document_type nhan an toan; size_bytes/mime_type chi khi co document_view.
-- Luon OMIT  : idempotency_key, checksum_sha256, storage key/bucket/URL (khong nam trong allowlist).
create or replace function public.direct_entry_change_request_proposal_projection(
  p_target_kind text,
  p_proposal jsonb,
  p_pii_view boolean,
  p_payment_view boolean,
  p_document_view boolean
)
returns jsonb
language sql
immutable
as $$
  select case p_target_kind
    when 'ENTRY_FIELD' then
      (
        select coalesce(jsonb_object_agg(entry_field.key, entry_field.value), '{}'::jsonb)
          from jsonb_each(p_proposal) as entry_field(key, value)
         where entry_field.key in (
           'project_id', 'first_work_date', 'employee_code', 'recruiter_id', 'labor_type'
         )
      ) || case
             when p_proposal ? 'worker_details' then
               case when coalesce(p_pii_view, false)
                 then jsonb_build_object('worker_details', p_proposal->'worker_details')
                 else jsonb_build_object('worker_details', jsonb_build_object('present', true))
               end
             else '{}'::jsonb
           end
    when 'PAYMENT' then
      jsonb_strip_nulls(jsonb_build_object(
        'state', p_proposal->'state',
        'account_number', case
          when p_proposal ? 'account_number' then
            case when coalesce(p_payment_view, false) then p_proposal->'account_number'
              else to_jsonb(
                case when p_proposal->>'account_number' is null then null
                  else repeat('•', greatest(length(p_proposal->>'account_number') - 4, 0))
                       || right(p_proposal->>'account_number', 4) end
              )
            end
          end,
        'bank_id', case when coalesce(p_payment_view, false) then p_proposal->'bank_id' end,
        'account_holder_name',
          case when coalesce(p_payment_view, false) then p_proposal->'account_holder_name' end
      ))
    when 'WORK_STATUS' then
      jsonb_strip_nulls(jsonb_build_object(
        'status', p_proposal->'status',
        'effective_date', p_proposal->'effective_date'
      ))
    when 'DOCUMENT' then
      jsonb_strip_nulls(jsonb_build_object(
        'document_type', p_proposal->'document_type',
        'size_bytes', case when coalesce(p_document_view, false) then p_proposal->'size_bytes' end,
        'mime_type', case when coalesce(p_document_view, false) then p_proposal->'mime_type' end
      ))
    else '{}'::jsonb
  end;
$$;
-- ---------------------------------------------------------------------------
-- 5. direct_entry_apply_change_item (replace): them capability theo target kind
-- ---------------------------------------------------------------------------
-- Giu nguyen hinh dang cu; chi them khoi kiem capability NGAY TRUOC mutation de helper nay
-- khong the bi goi thieu quyen tu bat ky duong nao (defense in depth).
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
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_reason_id uuid := p_reason_id;
  v_revision_id uuid;
  v_scope text;
  v_team_id uuid;
  v_provider text;
  v_date date;
  v_recruiter_id uuid;
  v_count integer;
  v_document_id uuid;
  v_status_version integer;
  v_latest public.direct_entry_employment_status_events%rowtype;
begin
  v_scope := public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'change_review', p_entry.created_by_user_id,
    p_entry.team_id, p_entry.first_work_date
  );
  -- Policy T0: capability bo sung theo target kind/proposal, kiem truoc khi ghi bat cu thu gi.
  if p_target_kind = 'ENTRY_FIELD' then
    if (p_proposal ? 'worker_details')
       and not public.direct_entry_has_capability(p_app_user_id, 'pii_view') then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  elsif p_target_kind = 'PAYMENT' then
    if not (public.direct_entry_has_capability(p_app_user_id, 'payment_view')
            and public.direct_entry_has_capability(p_app_user_id, 'payment_edit')) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  elsif p_target_kind = 'WORK_STATUS' then
    if not public.direct_entry_has_capability(p_app_user_id, 'employment_status.apply') then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  elsif p_target_kind = 'DOCUMENT' then
    if not (public.direct_entry_has_capability(p_app_user_id, 'document_view')
            and public.direct_entry_has_capability(p_app_user_id, 'document_upload')) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry.entry_id);
  if p_target_kind = 'ENTRY_FIELD' then
    if (p_proposal - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type']) <> '{}'::jsonb
       or p_proposal = '{}'::jsonb then
      raise exception 'unsupported entry proposal field' using errcode = '22023';
    end if;
    v_recruiter_id := case when p_proposal ? 'recruiter_id'
      then (p_proposal->>'recruiter_id')::uuid else p_entry.recruiter_id end;
    v_date := case when p_proposal ? 'first_work_date'
      then (p_proposal->>'first_work_date')::date else p_entry.first_work_date end;
    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id and m.valid_from <= v_date
       and (m.valid_to is null or v_date < m.valid_to);
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id and m.valid_from <= v_date
       and (m.valid_to is null or v_date < m.valid_to);
    if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
    perform public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_review',
      p_entry.created_by_user_id, v_team_id, v_date, v_scope
    );
    update public.direct_entries set
      project_id = case when p_proposal ? 'project_id' then p_proposal->>'project_id' else project_id end,
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
    p_auth_subject, p_app_user_id, 'change_request_approve', 'change_review',
    p_entry.entry_id::text, v_scope,
    case when v_scope = 'team' then
      case when p_target_kind = 'ENTRY_FIELD' then v_team_id else p_entry.team_id end
      else null end,
    'APPLIED', v_reason_id, v_revision_id, array[p_target_kind]
  );
  return v_revision_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. direct_entry_decide_change_request (replace): pre-pass capability cho TOAN BO item
-- ---------------------------------------------------------------------------
create or replace function public.direct_entry_decide_change_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_decision text,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request public.direct_entry_change_requests%rowtype;
  v_item record;
  v_entry public.direct_entries%rowtype;
  v_reason_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_revision_id uuid;
begin
  if p_decision not in ('APPROVED','REJECTED')
     or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid change decision input' using errcode = '22023';
  end if;
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'change_review'
  );
  select * into v_request from public.direct_entry_change_requests
   where request_id = p_request_id;
  if not found then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  if v_request.proposer_user_id = p_app_user_id then
    raise exception 'change request proposer cannot review own request' using errcode = '42501';
  end if;
  -- Policy T0: union capability cua MOI item, kiem TRUOC idempotency/mutation nen khong co
  -- partial apply, khong partial audit va khong tao TOCTOU (van doc trong cung transaction nay).
  perform public.direct_entry_assert_change_request_capabilities(
    p_auth_subject, p_app_user_id, p_request_id
  );
  for v_item in
    select i.entry_id from public.direct_entry_change_request_items i
     where i.request_id = p_request_id
  loop
    select * into v_entry from public.direct_entries where entry_id = v_item.entry_id;
    if not found then raise exception 'entry not found' using errcode = 'P0002'; end if;
    perform public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_review',
      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
    );
  end loop;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'change_request_' || lower(p_decision), p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'request_id', p_request_id, 'version', p_expected_version,
      'decision', p_decision, 'reason', p_reason
    ))
  );
  if v_prior is not null then return v_prior; end if;
  select * into v_request from public.direct_entry_change_requests
   where request_id = p_request_id for update;
  if not found or v_request.state <> 'PENDING'
     or v_request.version <> p_expected_version then
    raise exception 'change request version conflict' using errcode = '40001';
  end if;
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  if p_decision = 'APPROVED' then
    for v_item in
      select i.* from public.direct_entry_change_request_items i
       where i.request_id = p_request_id order by i.entry_id for update
    loop
      select * into v_entry from public.direct_entries
       where entry_id = v_item.entry_id for update;
      if not found or v_entry.deleted_at is not null
         or v_entry.version <> v_item.expected_version then
        raise exception 'change item version conflict' using errcode = '40001';
      end if;
      perform public.direct_entry_apply_change_item(
        p_auth_subject, p_app_user_id, p_request_id, v_entry,
        v_item.target_kind, v_item.proposal, v_reason_id
      );
    end loop;
  else
    for v_item in
      select i.entry_id from public.direct_entry_change_request_items i
       where i.request_id = p_request_id
    loop
      select * into v_entry from public.direct_entries where entry_id = v_item.entry_id;
      perform public.direct_entry_assert_entry_access(
        p_auth_subject, p_app_user_id, 'change_review',
        v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
      );
    end loop;
  end if;
  v_revision_id := public.direct_entry_write_change_request_revision(
    p_request_id, p_app_user_id, v_reason_id,
    jsonb_build_object('state',v_request.state,'version',v_request.version),
    jsonb_build_object('state',p_decision,'version',v_request.version + 1),
    v_request.version + 1
  );
  update public.direct_entry_change_requests
     set state = p_decision, version = version + 1,
         decided_by_user_id = p_app_user_id, decided_at = now(),
         decision_reason_id = v_reason_id
   where request_id = p_request_id;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    outcome, reason_id, change_request_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'change_request_' || lower(p_decision),
    'change_review', p_request_id::text, 'APPLIED', v_reason_id, v_revision_id,
    array['state','version']
  );
  v_result := jsonb_build_object(
    'request_id', p_request_id, 'state', p_decision, 'version', v_request.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'change_request_' || lower(p_decision), p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
-- ---------------------------------------------------------------------------
-- 7. direct_entry_read_change_request (replace): projection toi thieu theo capability
-- ---------------------------------------------------------------------------
-- Envelope tra ve KHONG doi (request_id/state/version/created_at/items/can_withdraw/can_decide)
-- de giu backward compatibility cho UI S03B1/S03B2 (5 truong ENTRY_FIELD non-PII van FULL).
-- Chi proposal cua tung item duoc project lai theo capability server-side cua viewer.
create or replace function public.direct_entry_read_change_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request public.direct_entry_change_requests%rowtype;
  v_audience text;
  v_pii_view boolean;
  v_payment_view boolean;
  v_document_view boolean;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if p_request_id is null then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  select * into v_request from public.direct_entry_change_requests
   where request_id = p_request_id;
  if not found then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  v_audience := public.direct_entry_change_request_audience(
    p_app_user_id, v_request.proposer_user_id, v_request.request_id
  );
  if v_audience = 'NONE' then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  v_pii_view := public.direct_entry_has_capability(p_app_user_id, 'pii_view');
  v_payment_view := public.direct_entry_has_capability(p_app_user_id, 'payment_view');
  v_document_view := public.direct_entry_has_capability(p_app_user_id, 'document_view');
  return jsonb_build_object(
    'request_id', v_request.request_id,
    'state', v_request.state,
    'version', v_request.version,
    'created_at',
      pg_catalog.to_char(v_request.created_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_request.created_at at time zone 'UTC', 'HH24:MI:SS.US')
      || 'Z',
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'entry_id', i.entry_id,
               'target_kind', i.target_kind,
               'expected_version', i.expected_version,
               'proposal', public.direct_entry_change_request_proposal_projection(
                 i.target_kind, i.proposal, v_pii_view, v_payment_view, v_document_view
               )
             ) order by i.entry_id), '[]'::jsonb)
        from public.direct_entry_change_request_items i
       where i.request_id = v_request.request_id
    ),
    'can_withdraw', (v_audience = 'PROPOSER' and v_request.state = 'PENDING'),
    'can_decide', (v_audience = 'REVIEWER' and v_request.state = 'PENDING')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. direct_entry_entry_snapshot (replace): redact CO DINH luc ghi
-- ---------------------------------------------------------------------------
-- Snapshot la du lieu revision duoc GHI VAO BANG, khong phai projection theo viewer: moi viewer
-- doc cung mot ban da redact. Giu: field names, presence/status, gia tri khong nhay cam can thiet,
-- version/lineage identifier an toan. Khong rewrite/xoa revision cu (chi revision moi redact).
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
    'recruiter_id', e.recruiter_id,
    'team_id', e.team_id,
    'provider_type', e.provider_type,
    'labor_type', e.labor_type,
    'version', e.version,
    'deleted_at', e.deleted_at,
    'employment_status', (
      select jsonb_build_object(
        'status', st.status, 'effective_date', st.effective_date,
        'version', st.version
      )
        from public.direct_entry_employment_status_events st
       where st.entry_id = e.entry_id order by st.version desc limit 1
    ),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'document_id', d.document_id, 'document_type', d.document_type,
        'version', d.version, 'upload_status', latest.upload_status,
        'scan_status', latest.scan_status,
        'validation_status', latest.validation_status,
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

-- ---------------------------------------------------------------------------
-- 9. ACL: helper noi bo khong grant cho bat ky role nao; RPC public giu nguyen grant cu
-- ---------------------------------------------------------------------------
revoke all on function public.direct_entry_has_capability(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_change_request_required_capabilities(uuid) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_assert_change_request_capabilities(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_change_request_proposal_projection(text, jsonb, boolean, boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_apply_change_item(uuid, uuid, uuid, public.direct_entries, text, jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_decide_change_request(uuid, uuid, uuid, integer, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_entry_snapshot(uuid) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_read_change_request(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_read_change_request(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Self-check: migration phai that bai neu policy/ACL khong duoc cai dat dung
-- ---------------------------------------------------------------------------
do $$
declare
  v_anon boolean;
  v_helper boolean;
begin
  select has_function_privilege('anon', p.oid, 'EXECUTE')
    into v_anon
    from pg_proc p
   where p.oid = 'public.direct_entry_has_capability(uuid, text)'::regprocedure;
  if coalesce(v_anon, true) then
    raise exception 'helper ACL khong duoc revoke dung' using errcode = '42501';
  end if;
  select has_function_privilege('service_role', p.oid, 'EXECUTE')
    into v_helper
    from pg_proc p
   where p.oid =
     'public.direct_entry_assert_change_request_capabilities(uuid, uuid, uuid)'::regprocedure;
  if coalesce(v_helper, true) then
    raise exception 'helper noi bo khong duoc cap EXECUTE' using errcode = '42501';
  end if;
end;
$$;
