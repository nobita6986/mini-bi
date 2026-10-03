-- P1.6-W04-S04C-S02B - Read/list change request (LOCAL-ONLY, forward-only).
--
-- Pham vi:
--   * Chi them RPC doc (security definer, search_path co dinh, service-role-only).
--   * KHONG doi table/schema/migration da co, KHONG cap table DML/read cho service_role/client.
--   * KHONG tra raw revision/audit/idempotency/reason text/PII/payment/document payload.
--
-- Authority: mapping auth_subject <-> app_user_id + actor enabled + capability + effective scope tung entry
-- duoc resolve NGAY TRONG DB (khong co authority thu hai o application, khong doc truoc DB).
--
-- ROLLBACK (chay tay, thu tu nguoc):
--   drop function if exists public.direct_entry_read_change_request(uuid, uuid, uuid);
--   drop function if exists public.direct_entry_list_change_requests(uuid, uuid, integer, text, text);
--   drop function if exists public.direct_entry_change_request_audience(uuid, uuid, uuid);
--   drop function if exists public.direct_entry_has_entry_access(uuid, text, uuid, uuid, date);
--   drop function if exists public.direct_entry_assert_actor_mapping(uuid, uuid);

-- ---------------------------------------------------------------------------
-- 1. Helper noi bo: mapping actor + scope tung entry (mirror assert_entry_access)
-- ---------------------------------------------------------------------------

-- Chi kiem mapping auth_subject <-> app_user_id va actor enabled. Khong gan voi mot capability
-- cu the vi list/detail phuc vu ca proposer (change_request_create) lan reviewer (change_review).
create or replace function public.direct_entry_assert_actor_mapping(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
  ) then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;
end;
$$;

-- Ban boolean cua direct_entry_assert_entry_access: cung dieu kien actor enabled + capability
-- con hieu luc + DUNG MOT scope grant khop (own/team/all). Dung cho duong doc (loc, khong raise).
create or replace function public.direct_entry_has_entry_access(
  p_app_user_id uuid,
  p_capability text,
  p_entry_owner uuid,
  p_team_id uuid,
  p_effective_date date
)
returns boolean
language sql
security definer
set search_path = pg_catalog, public
as $$
  select exists (
           select 1 from public.direct_entry_app_users u
            where u.app_user_id = p_app_user_id and u.enabled
         )
     and exists (
           select 1 from public.direct_entry_capability_grants g
            where g.app_user_id = p_app_user_id
              and g.capability = p_capability
              and g.valid_from <= public.direct_entry_authorization_date()
              and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
         )
     and (
           select count(*) from public.direct_entry_scope_grants sg
            where sg.app_user_id = p_app_user_id
              and sg.valid_from <= p_effective_date
              and (sg.valid_to is null or p_effective_date < sg.valid_to)
              and (
                (sg.scope_kind = 'own' and p_entry_owner = p_app_user_id)
                or (sg.scope_kind = 'team' and p_team_id is not null and sg.team_id = p_team_id)
                or sg.scope_kind = 'all'
              )
         ) = 1;
$$;

-- Audience cua mot request voi mot actor: PROPOSER | REVIEWER | NONE.
-- Fail-closed: request chi hien khi actor co quyen tren TOAN BO item; thieu mot item la NONE.
-- Proposer khong bao gio la REVIEWER cua chinh request minh (self-review do mutation RPC quyet dinh).
create or replace function public.direct_entry_change_request_audience(
  p_app_user_id uuid,
  p_proposer_user_id uuid,
  p_request_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_capability text;
  v_items integer;
  v_accessible integer;
begin
  if p_app_user_id is null or p_proposer_user_id is null or p_request_id is null then
    return 'NONE';
  end if;
  v_capability := case when p_proposer_user_id = p_app_user_id
    then 'change_request_create' else 'change_review' end;
  select count(*) into v_items
    from public.direct_entry_change_request_items i
   where i.request_id = p_request_id;
  if v_items < 1 then
    return 'NONE';
  end if;
  select count(*) into v_accessible
    from public.direct_entry_change_request_items i
    join public.direct_entries e on e.entry_id = i.entry_id
   where i.request_id = p_request_id
     and public.direct_entry_has_entry_access(
           p_app_user_id, v_capability, e.created_by_user_id, e.team_id, e.first_work_date
         );
  if v_accessible <> v_items then
    return 'NONE';
  end if;
  return case when p_proposer_user_id = p_app_user_id then 'PROPOSER' else 'REVIEWER' end;
end;
$$;
-- ---------------------------------------------------------------------------
-- 2. direct_entry_list_change_requests
-- ---------------------------------------------------------------------------
-- Keyset pagination (khong offset): order co dinh created_at DESC, request_id DESC;
-- cursor opaque dang <yyyyMMddHH24MISSUS>:<request_id> (UTC, 20 chu so, so sanh tuple text).
-- Loc state tuy chon, chi nhan dung vocabulary PENDING|APPROVED|REJECTED|WITHDRAWN.
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
  if p_state is not null then
    if p_state not in ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN') then
      raise exception 'invalid change request state filter' using errcode = '22023';
    end if;
  end if;
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    v_cursor_stamp := pg_catalog.split_part(p_cursor, ':', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, ':', 2)::uuid;
  end if;

  with candidates as (
    select r.request_id,
           r.state,
           r.version,
           r.created_at,
           public.direct_entry_change_request_audience(
             p_app_user_id, r.proposer_user_id, r.request_id
           ) as audience
      from public.direct_entry_change_requests r
     where (p_state is null or r.state = p_state)
       and (
         v_cursor_stamp is null
         or (
              pg_catalog.to_char(r.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
              r.request_id::text
            ) < (v_cursor_stamp, v_cursor_id::text)
       )
  ),
  visible as (
    select * from candidates where audience <> 'NONE'
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
  select
    (select count(*)::int from page),
    (
      select coalesce(jsonb_agg(jsonb_build_object(
               'request_id', t.request_id,
               'state', t.state,
               'version', t.version,
               'created_at',
                 pg_catalog.to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD')
                 || 'T' || pg_catalog.to_char(t.created_at at time zone 'UTC', 'HH24:MI:SS.US')
                 || 'Z',
               'item_count', (
                 select count(*)::int from public.direct_entry_change_request_items i
                  where i.request_id = t.request_id
               ),
               'entry_ids', (
                 select coalesce(jsonb_agg(i.entry_id order by i.entry_id), '[]'::jsonb)
                   from public.direct_entry_change_request_items i
                  where i.request_id = t.request_id
               ),
               'can_withdraw', (t.audience = 'PROPOSER' and t.state = 'PENDING'),
               'can_decide', (t.audience = 'REVIEWER' and t.state = 'PENDING')
             ) order by t.created_at desc, t.request_id desc), '[]'::jsonb)
        from trimmed t
    ),
    (
      select t.cursor from trimmed t
       order by t.created_at asc, t.request_id asc limit 1
    )
  into v_scanned, v_rows, v_next_cursor;

  v_has_more := v_scanned > v_page_size;
  return jsonb_build_object(
    'requests', v_rows,
    'page_size', v_page_size,
    'has_more', v_has_more,
    'next_cursor', case when v_has_more then v_next_cursor else null end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. direct_entry_read_change_request
-- ---------------------------------------------------------------------------
-- Khong tim thay va khong co quyen tra VE CUNG mot ma (P0002) de tranh enumeration.
-- Proposal tra nguyen vocabulary W01/W03 da khoa; KHONG tra reason/reason_id/audit/revision/PII.
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
               'proposal', i.proposal
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
-- 4. ACL: helper noi bo khong grant cho ai; hai RPC doc chi service_role
-- ---------------------------------------------------------------------------
revoke all on function public.direct_entry_assert_actor_mapping(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_has_entry_access(uuid, text, uuid, uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_change_request_audience(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_list_change_requests(uuid, uuid, integer, text, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_read_change_request(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_change_requests(uuid, uuid, integer, text, text) to service_role;
grant execute on function public.direct_entry_read_change_request(uuid, uuid, uuid) to service_role;
