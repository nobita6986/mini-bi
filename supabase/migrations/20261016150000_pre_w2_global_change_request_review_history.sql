-- PRE-W2-HF #109: global, read-only change-request decision history for global reviewers.
begin;

create index if not exists direct_entry_change_requests_review_history_idx
  on public.direct_entry_change_requests (decided_at desc, request_id desc)
  where state in ('APPROVED', 'REJECTED');

create or replace function public.direct_entry_list_global_change_request_history(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_page_size integer,
  p_cursor text,
  p_days integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_page_size integer := coalesce(p_page_size, 20);
  v_cursor_stamp text;
  v_cursor_id uuid;
  v_scanned integer;
  v_rows jsonb;
  v_next_cursor text;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if not public.direct_entry_has_scope(p_app_user_id, 'all')
     or not (public.direct_entry_has_capability(p_app_user_id, 'change_review')
       or public.direct_entry_has_capability(p_app_user_id, 'entry_admin')) then
    raise exception 'global change request history denied' using errcode = '42501';
  end if;
  if v_page_size < 1 or v_page_size > 50 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  if p_days is not null and p_days not in (3, 7, 30) then
    raise exception 'invalid history window' using errcode = '22023';
  end if;
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    v_cursor_stamp := pg_catalog.split_part(p_cursor, ':', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, ':', 2)::uuid;
  end if;

  with candidates as (
    select r.request_id, r.state, r.version, r.created_at, r.decided_at,
           coalesce(nullif(btrim(decider.display_name), ''), 'Người dùng') as decided_by_display_name,
           coalesce(nullif(btrim(proposer.display_name), ''), 'Người dùng') as proposer_display_name,
           (select string_agg(distinct case i.target_kind
              when 'ENTRY_FIELD' then 'Thông tin người lao động'
              when 'WORKER' then 'Thông tin người lao động'
              when 'PAYMENT' then 'Thông tin ngân hàng'
              when 'WORK_STATUS' then 'Trạng thái làm việc'
              when 'DOCUMENT' then 'Tài liệu hồ sơ'
              else 'Yêu cầu thay đổi' end, ' · ' order by case i.target_kind
              when 'ENTRY_FIELD' then 'Thông tin người lao động'
              when 'WORKER' then 'Thông tin người lao động'
              when 'PAYMENT' then 'Thông tin ngân hàng'
              when 'WORK_STATUS' then 'Trạng thái làm việc'
              when 'DOCUMENT' then 'Tài liệu hồ sơ'
              else 'Yêu cầu thay đổi' end)
              from public.direct_entry_change_request_items i where i.request_id = r.request_id) as summary
      from public.direct_entry_change_requests r
      join public.direct_entry_app_users proposer on proposer.app_user_id = r.proposer_user_id
      join public.direct_entry_app_users decider on decider.app_user_id = r.decided_by_user_id
     where r.state in ('APPROVED', 'REJECTED')
       and (p_days is null or r.decided_at >= now() - pg_catalog.make_interval(days => p_days))
       and (v_cursor_stamp is null or (
         pg_catalog.to_char(r.decided_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
         r.request_id::text
       ) < (v_cursor_stamp, v_cursor_id::text))
  ),
  page as (
    select c.*,
           pg_catalog.to_char(c.decided_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
             || ':' || c.request_id::text as cursor
      from candidates c
     order by c.decided_at desc, c.request_id desc
     limit v_page_size + 1
  ),
  trimmed as (
    select * from page order by decided_at desc, request_id desc limit v_page_size
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
       'can_withdraw', false, 'can_decide', false,
       'proposer_display_name', t.proposer_display_name,
       'summary', t.summary,
       'decided_by_display_name', t.decided_by_display_name,
       'decided_at', pg_catalog.to_char(t.decided_at at time zone 'UTC', 'YYYY-MM-DD')
         || 'T' || pg_catalog.to_char(t.decided_at at time zone 'UTC', 'HH24:MI:SS.US') || 'Z'
     ) order by t.decided_at desc, t.request_id desc), '[]'::jsonb) from trimmed t),
    (select t.cursor from trimmed t order by t.decided_at asc, t.request_id asc limit 1)
  into v_scanned, v_rows, v_next_cursor;

  return jsonb_build_object(
    'requests', v_rows,
    'page_size', v_page_size,
    'has_more', v_scanned > v_page_size,
    'next_cursor', case when v_scanned > v_page_size then v_next_cursor else null end
  );
end;
$$;

-- Global admins may inspect terminal audit details, but this read-only audience
-- never receives can_decide and does not broaden any decision RPC.
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
  if v_audience = 'NONE'
     and v_request.state in ('APPROVED', 'REJECTED')
     and public.direct_entry_has_scope(p_app_user_id, 'all')
     and public.direct_entry_has_capability(p_app_user_id, 'entry_admin') then
    v_audience := 'AUDITOR';
  end if;
  if v_audience = 'NONE' then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  v_pii_view := public.direct_entry_has_capability(p_app_user_id, 'pii_view');
  v_payment_view := public.direct_entry_has_capability(p_app_user_id, 'payment_view');
  v_document_view := public.direct_entry_has_capability(p_app_user_id, 'document_view');
  if v_audience in ('REVIEWER', 'AUDITOR') then
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
                 when i.target_kind = 'WORK_STATUS' and v_audience in ('REVIEWER', 'AUDITOR')
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
$$;

revoke all on function public.direct_entry_read_change_request(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_read_change_request(uuid, uuid, uuid)
  to service_role;
comment on function public.direct_entry_read_change_request(uuid, uuid, uuid) is
  'Read change request detail for its existing audience, plus read-only terminal audit access for all-scope entry admins.';

revoke all on function public.direct_entry_list_global_change_request_history(uuid, uuid, integer, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_global_change_request_history(uuid, uuid, integer, text, integer)
  to service_role;
comment on function public.direct_entry_list_global_change_request_history(uuid, uuid, integer, text, integer) is
  'PRE-W2-HF #109: read-only global APPROVED/REJECTED history for all-scope change_review or entry_admin actors; actor and authorization are verified server-side.';

do $$
declare
  v_sig regprocedure := 'public.direct_entry_list_global_change_request_history(uuid,uuid,integer,text,integer)'::regprocedure;
begin
  if not (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
            from pg_proc p where p.oid = v_sig)
     or not has_function_privilege('service_role', v_sig, 'EXECUTE')
     or has_function_privilege('authenticated', v_sig, 'EXECUTE')
     or has_function_privilege('anon', v_sig, 'EXECUTE')
     or to_regclass('public.direct_entry_change_requests_review_history_idx') is null then
    raise exception 'global change request history boundary not installed';
  end if;
end;
$$;

commit;
