-- R2.1: formalize 4 Change Request queues (PROPOSER_PENDING, PROPOSER_RESOLVED,
-- REVIEWER_PENDING, REVIEWER_RESOLVED) + historical proposer/decider read boundaries,
-- enforce project-team effective scope on Team Leader ENTRY_FIELD approvals,
-- and remove subtransaction exception handling from direct_entry_resolve_direct_edit_authority.
begin;

create or replace function public.direct_entry_list_change_requests(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_page_size integer,
  p_cursor text,
  p_state text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_page_size integer;
  v_cursor_stamp text;
  v_cursor_id uuid;
  v_scanned integer;
  v_rows jsonb;
  v_next_cursor text;
  v_has_more boolean;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  v_page_size := coalesce(p_page_size, 20);
  if v_page_size < 1 or v_page_size > 50 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  if p_state is not null and p_state not in (
       'PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'RESOLVED',
       'PROPOSER_PENDING', 'PROPOSER_RESOLVED', 'REVIEWER_PENDING', 'REVIEWER_RESOLVED'
     ) then
    raise exception 'invalid change request state filter' using errcode = '22023';
  end if;
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    v_cursor_stamp := pg_catalog.split_part(p_cursor, ':', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, ':', 2)::uuid;
  end if;

  with candidates as (
    select r.request_id, r.state, r.version, r.created_at,
           r.proposer_user_id, r.decided_by_user_id,
           public.direct_entry_change_request_audience(
             p_app_user_id, r.proposer_user_id, r.request_id
           ) as audience
      from public.direct_entry_change_requests r
     where (
       p_state is null
       or (p_state = 'RESOLVED' and r.state in ('APPROVED', 'REJECTED', 'WITHDRAWN'))
       or (p_state = 'PROPOSER_PENDING' and r.state = 'PENDING' and r.proposer_user_id = p_app_user_id)
       or (p_state = 'PROPOSER_RESOLVED' and r.state in ('APPROVED', 'REJECTED', 'WITHDRAWN') and r.proposer_user_id = p_app_user_id)
       or (p_state = 'REVIEWER_PENDING' and r.state = 'PENDING' and r.proposer_user_id <> p_app_user_id)
       or (p_state = 'REVIEWER_RESOLVED' and r.state in ('APPROVED', 'REJECTED') and r.decided_by_user_id = p_app_user_id and r.proposer_user_id <> p_app_user_id)
       or (p_state in ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN') and r.state = p_state)
     )
       and (v_cursor_stamp is null or (
         pg_catalog.to_char(r.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
         r.request_id::text
       ) < (v_cursor_stamp, v_cursor_id::text))
  ),
  visible as (
    select *
      from candidates
     where case
       when p_state = 'PROPOSER_PENDING' then
         proposer_user_id = p_app_user_id and state = 'PENDING'
       when p_state = 'PROPOSER_RESOLVED' then
         proposer_user_id = p_app_user_id and state in ('APPROVED', 'REJECTED', 'WITHDRAWN')
       when p_state = 'REVIEWER_PENDING' then
         proposer_user_id <> p_app_user_id and state = 'PENDING' and audience = 'REVIEWER'
       when p_state = 'REVIEWER_RESOLVED' then
         proposer_user_id <> p_app_user_id and state in ('APPROVED', 'REJECTED') and decided_by_user_id = p_app_user_id
       when p_state in ('RESOLVED', 'APPROVED', 'REJECTED', 'WITHDRAWN') then
         audience <> 'NONE'
         or proposer_user_id = p_app_user_id
         or (state in ('APPROVED', 'REJECTED') and decided_by_user_id = p_app_user_id and proposer_user_id <> p_app_user_id)
       else
         audience <> 'NONE'
     end
  ),
  page as (
    select v.*,
           pg_catalog.to_char(v.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
             || ':' || v.request_id::text as cursor
      from visible v
     order by v.created_at desc, v.request_id desc
     limit v_page_size + 1
  ),
  trimmed as (
    select * from page order by created_at desc, request_id desc limit v_page_size
  )
  select (select count(*)::int from page),
    (select coalesce(jsonb_agg(jsonb_build_object(
       'request_id', t.request_id, 'state', t.state, 'version', t.version,
       'created_at', pg_catalog.to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD')
         || 'T' || pg_catalog.to_char(t.created_at at time zone 'UTC', 'HH24:MI:SS.US') || 'Z',
       'item_count', (select count(*)::int from public.direct_entry_change_request_items i
                       where i.request_id = t.request_id),
       'entry_ids', (select coalesce(jsonb_agg(i.entry_id order by i.entry_id), '[]'::jsonb)
                       from public.direct_entry_change_request_items i
                      where i.request_id = t.request_id),
       'can_withdraw', (t.audience = 'PROPOSER' and t.state = 'PENDING'),
       'can_decide', (t.audience = 'REVIEWER' and t.state = 'PENDING'),
       'proposer_display_name', (select coalesce(nullif(btrim(u.display_name),''),'Người dùng') from public.direct_entry_change_requests r join public.direct_entry_app_users u on u.app_user_id=r.proposer_user_id where r.request_id=t.request_id),
       'summary', (select string_agg(distinct case i.target_kind when 'ENTRY_FIELD' then 'Thông tin người lao động' when 'WORKER' then 'Thông tin người lao động' when 'PAYMENT' then 'Thông tin ngân hàng' when 'WORK_STATUS' then 'Trạng thái làm việc' when 'DOCUMENT' then 'Tài liệu hồ sơ' when 'ENTRY_VOID' then 'Đề nghị hủy hồ sơ trùng' else 'Yêu cầu thay đổi' end, ' · ' order by case i.target_kind when 'ENTRY_FIELD' then 'Thông tin người lao động' when 'WORKER' then 'Thông tin người lao động' when 'PAYMENT' then 'Thông tin ngân hàng' when 'WORK_STATUS' then 'Trạng thái làm việc' when 'DOCUMENT' then 'Tài liệu hồ sơ' when 'ENTRY_VOID' then 'Đề nghị hủy hồ sơ trùng' else 'Yêu cầu thay đổi' end) from public.direct_entry_change_request_items i where i.request_id=t.request_id)
     ) order by t.created_at desc, t.request_id desc), '[]'::jsonb) from trimmed t),
    (select t.cursor from trimmed t order by t.created_at asc, t.request_id asc limit 1)
  into v_scanned, v_rows, v_next_cursor;
  v_has_more := v_scanned > v_page_size;
  return jsonb_build_object(
    'requests', v_rows, 'page_size', v_page_size, 'has_more', v_has_more,
    'next_cursor', case when v_has_more then v_next_cursor else null end
  );
end;
$function$;

create or replace function public.direct_entry_read_change_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_request public.direct_entry_change_requests%rowtype;
  v_audience text;
  v_pii_view boolean;
  v_payment_view boolean;
  v_document_view boolean;
  v_request_reason text;
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
    if v_request.proposer_user_id = p_app_user_id then
      v_audience := 'PROPOSER_HISTORY';
    elsif v_request.state in ('APPROVED', 'REJECTED')
          and v_request.decided_by_user_id = p_app_user_id
          and v_request.proposer_user_id <> p_app_user_id then
      v_audience := 'DECIDER_HISTORY';
    elsif v_request.state in ('APPROVED', 'REJECTED')
          and public.direct_entry_has_scope(p_app_user_id, 'all')
          and (public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
               or public.direct_entry_has_capability(p_app_user_id, 'change_review')) then
      v_audience := 'AUDITOR';
    end if;
  end if;
  if v_audience = 'NONE' then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  v_pii_view := true;
  v_payment_view := true;
  v_document_view := public.direct_entry_has_capability(p_app_user_id, 'document_view');
  if v_audience in ('REVIEWER', 'AUDITOR', 'DECIDER_HISTORY') then
    select rr.reason_text into v_request_reason
      from public.direct_entry_restricted_reasons rr
     where rr.reason_id = v_request.reason_id;
  end if;
  return jsonb_build_object(
    'request_id', v_request.request_id,
    'state', v_request.state,
    'version', v_request.version,
    'created_at', pg_catalog.to_char(v_request.created_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_request.created_at at time zone 'UTC', 'HH24:MI:SS.US') || 'Z',
    'request_reason', v_request_reason,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'entry_id', i.entry_id,
               'target_kind', i.target_kind,
               'expected_version', i.expected_version,
               'proposal', case
                 when i.target_kind = 'WORK_STATUS'
                      and v_audience in ('REVIEWER', 'AUDITOR', 'DECIDER_HISTORY')
                      and i.proposal ? 'leave_reason'
                   then public.direct_entry_change_request_proposal_projection(
                     i.target_kind, i.proposal, v_pii_view, v_payment_view, v_document_view
                   ) || jsonb_build_object('leave_reason', i.proposal->'leave_reason')
                 else public.direct_entry_change_request_proposal_projection(
                   i.target_kind, i.proposal, v_pii_view, v_payment_view, v_document_view
                 )
               end,
               'labor_type_display', case
                 when i.target_kind = 'ENTRY_FIELD'
                      and nullif(i.proposal->>'labor_type', '') is not null
                   then (select lt.display_name from public.direct_entry_labor_types lt
                          where lt.labor_type_key = i.proposal->>'labor_type')
                 else null end
             ) order by i.entry_id), '[]'::jsonb)
        from public.direct_entry_change_request_items i
       where i.request_id = v_request.request_id
    ),
    'can_withdraw', (v_audience = 'PROPOSER' and v_request.state = 'PENDING'),
    'can_decide', (v_audience = 'REVIEWER' and v_request.state = 'PENDING')
  );
end;
$function$;

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
  v_before := public.direct_entry_entry_snapshot(p_entry.entry_id);
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
    update public.direct_entries set
      voided_at = now(), voided_by_user_id = p_app_user_id, void_reason_id = v_reason_id,
      version = version + 1
     where entry_id = p_entry.entry_id and voided_at is null;
    if not found then
      raise exception 'entry already voided' using errcode = '40001';
    end if;
  elsif p_target_kind = 'ENTRY_FIELD' then
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

create or replace function public.direct_entry_resolve_direct_edit_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_owner uuid,
  p_team_id uuid,
  p_project_id text,
  p_is_full_admin boolean,
  p_team_leader_team_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope text;
begin
  if p_is_full_admin then return 'admin_all'; end if;

  if exists (
       select 1
         from public.direct_entry_app_users u
        where u.app_user_id = p_app_user_id
          and u.auth_subject = p_auth_subject
          and u.enabled
     )
     and public.direct_entry_has_entry_access(
       p_app_user_id, 'entry_privileged_edit', p_entry_owner, p_team_id, null
     ) then
    select min(g.scope_kind) into v_scope
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id and g.is_current
       and (g.scope_kind <> 'team' or exists (
         select 1 from public.teams t where t.team_id = g.team_id and t.active
       ))
       and ((g.scope_kind = 'own' and p_entry_owner = p_app_user_id)
         or (g.scope_kind = 'team' and p_team_id is not null and g.team_id = p_team_id)
         or g.scope_kind = 'all');
    if v_scope is not null then
      return 'privileged_' || v_scope;
    end if;
  end if;

  if public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_project_id) then
    return 'project_manager';
  end if;
  if p_team_id is not null and p_team_id = p_team_leader_team_id then
    return 'team_leader';
  end if;
  return null;
end;
$function$;

-- Preserve S0-T1-C allowlist and internal helper boundaries.
revoke all on function public.direct_entry_list_change_requests(
  uuid, uuid, integer, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_change_requests(
  uuid, uuid, integer, text, text
) to service_role;

revoke all on function public.direct_entry_read_change_request(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_read_change_request(
  uuid, uuid, uuid
) to service_role;

revoke all on function public.direct_entry_apply_change_item(
  uuid, uuid, uuid, public.direct_entries, text, jsonb, uuid
) from public, anon, authenticated, service_role;

revoke all on function public.direct_entry_resolve_direct_edit_authority(
  uuid, uuid, uuid, uuid, text, boolean, uuid
) from public, anon, authenticated, service_role;

-- Ensure SECURITY DEFINER function owners retain EXECUTE on internal helpers
-- even when migrations run under a non-superuser operator role.
do $grant_r2_1_internal$
declare
  v_owner name;
begin
  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid in (
       'public.direct_entry_list_change_requests(uuid,uuid,integer,text,text)'::regprocedure,
       'public.direct_entry_read_change_request(uuid,uuid,uuid)'::regprocedure,
       'public.direct_entry_decide_change_request(uuid,uuid,uuid,integer,text,text,text)'::regprocedure,
       'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::regprocedure,
       'public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)'::regprocedure,
       'public.direct_entry_list_workers_search(text,uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure,
       'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure
     )
  loop
    execute format(
      'grant execute on function public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid) to %I',
      v_owner
    );
    execute format(
      'grant execute on function public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid) to %I',
      v_owner
    );
    execute format(
      'grant execute on function public.direct_entry_has_entry_access(uuid,text,uuid,uuid,date) to %I',
      v_owner
    );
    execute format(
      'grant execute on function public.direct_entry_project_team_scope_effective(text,uuid) to %I',
      v_owner
    );
    execute format(
      'grant execute on function public.direct_entry_actor_is_assigned_project_manager(uuid,text) to %I',
      v_owner
    );
  end loop;
end;
$grant_r2_1_internal$;

do $assert_r2_1_boundary$
declare
  v_list regprocedure := 'public.direct_entry_list_change_requests(uuid,uuid,integer,text,text)'::regprocedure;
  v_read regprocedure := 'public.direct_entry_read_change_request(uuid,uuid,uuid)'::regprocedure;
  v_apply regprocedure := 'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::regprocedure;
  v_resolver regprocedure := 'public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)'::regprocedure;
begin
  if has_function_privilege('public', v_list, 'EXECUTE')
     or has_function_privilege('anon', v_list, 'EXECUTE')
     or has_function_privilege('authenticated', v_list, 'EXECUTE')
     or not has_function_privilege('service_role', v_list, 'EXECUTE')
     or has_function_privilege('public', v_read, 'EXECUTE')
     or has_function_privilege('anon', v_read, 'EXECUTE')
     or has_function_privilege('authenticated', v_read, 'EXECUTE')
     or not has_function_privilege('service_role', v_read, 'EXECUTE')
     or has_function_privilege('public', v_apply, 'EXECUTE')
     or has_function_privilege('anon', v_apply, 'EXECUTE')
     or has_function_privilege('authenticated', v_apply, 'EXECUTE')
     or has_function_privilege('service_role', v_apply, 'EXECUTE')
     or has_function_privilege('public', v_resolver, 'EXECUTE')
     or has_function_privilege('anon', v_resolver, 'EXECUTE')
     or has_function_privilege('authenticated', v_resolver, 'EXECUTE')
     or has_function_privilege('service_role', v_resolver, 'EXECUTE')
     or not (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
               from pg_catalog.pg_proc p where p.oid = v_list)
     or not (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
               from pg_catalog.pg_proc p where p.oid = v_read)
     or not (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
               from pg_catalog.pg_proc p where p.oid = v_apply)
     or not (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
               from pg_catalog.pg_proc p where p.oid = v_resolver) then
    raise exception 'R2.1 RPC boundary drift' using errcode = '55000';
  end if;
end;
$assert_r2_1_boundary$;

commit;
