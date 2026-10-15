-- PRE-W2: reviewer queue filters and reviewer-only request/leave reasons.
-- No business rows are changed; existing request states and authorization remain authoritative.
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
as $$
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
  if p_state is not null and p_state not in
       ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'RESOLVED') then
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
           public.direct_entry_change_request_audience(
             p_app_user_id, r.proposer_user_id, r.request_id
           ) as audience
      from public.direct_entry_change_requests r
     where (p_state is null
       or (p_state = 'RESOLVED' and r.state in ('APPROVED', 'REJECTED', 'WITHDRAWN'))
       or r.state = p_state)
       and (v_cursor_stamp is null or (
         pg_catalog.to_char(r.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
         r.request_id::text
       ) < (v_cursor_stamp, v_cursor_id::text))
  ),
  visible as (select * from candidates where audience <> 'NONE'),
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
       'can_decide', (t.audience = 'REVIEWER' and t.state = 'PENDING')
     ) order by t.created_at desc, t.request_id desc), '[]'::jsonb) from trimmed t),
    (select t.cursor from trimmed t order by t.created_at asc, t.request_id asc limit 1)
  into v_scanned, v_rows, v_next_cursor;
  v_has_more := v_scanned > v_page_size;
  return jsonb_build_object(
    'requests', v_rows, 'page_size', v_page_size, 'has_more', v_has_more,
    'next_cursor', case when v_has_more then v_next_cursor else null end
  );
end;
$$;

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
  if v_audience = 'NONE' then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  v_pii_view := public.direct_entry_has_capability(p_app_user_id, 'pii_view');
  v_payment_view := public.direct_entry_has_capability(p_app_user_id, 'payment_view');
  v_document_view := public.direct_entry_has_capability(p_app_user_id, 'document_view');
  if v_audience = 'REVIEWER' then
    select rr.reason_text into v_request_reason
      from public.direct_entry_restricted_reasons rr
     where rr.reason_id = v_request.reason_id;
  end if;
  return jsonb_build_object(
    'request_id', v_request.request_id, 'state', v_request.state,
    'version', v_request.version,
    'created_at', pg_catalog.to_char(v_request.created_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_request.created_at at time zone 'UTC', 'HH24:MI:SS.US') || 'Z',
    'request_reason', v_request_reason,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'entry_id', i.entry_id, 'target_kind', i.target_kind,
        'expected_version', i.expected_version,
        'proposal', case
          when i.target_kind = 'WORK_STATUS' and v_audience = 'REVIEWER'
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

revoke all on function public.direct_entry_list_change_requests(uuid, uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_change_requests(uuid, uuid, integer, text, text)
  to service_role;
revoke all on function public.direct_entry_read_change_request(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_read_change_request(uuid, uuid, uuid)
  to service_role;

do $$
begin
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_list_change_requests(uuid,uuid,integer,text,text)'::regprocedure
       and p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) or not exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_read_change_request(uuid,uuid,uuid)'::regprocedure
       and p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    raise exception 'PRE-W2 change-request review RPC security boundary mismatch';
  end if;
end;
$$;

commit;
