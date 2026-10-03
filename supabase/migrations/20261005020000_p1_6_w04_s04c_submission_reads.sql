-- P1.6-W04-S04C-S02C - Read/list own submissions (LOCAL-ONLY, forward-only).
--
-- Muc dich: UI lifecycle tai lai trang van thay submission o ca ba trang thai DRAFT/REVIEW/SUBMITTED
-- ma khong phai giu trang thai trong client state; DB/RPC van la authority cuoi.
--
-- Authority mirror DUNG theo public.direct_entry_transition_submission:
--   * direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'submission_create')  (mapping + enabled + capability)
--   * dung MOT own scope grant con hieu luc (scope_kind = 'own' AND team_id IS NULL)
--   * submission.created_by_user_id = p_app_user_id
-- Khong cho own/team/all thay the lan nhau; khong co authority thu hai o application.
--
-- Khong them helper executable moi: chi dung lai helper noi bo da co tu migration #31
-- (khong can cho hai RPC nay) va hai RPC public moi duoi day.
-- Khong doi ACL cua bat ky RPC/table nao khac.
--
-- ROLLBACK (chay tay, thu tu nguoc):
--   drop function if exists public.direct_entry_read_own_submission(uuid, uuid, uuid);
--   drop function if exists public.direct_entry_list_own_submissions(uuid, uuid, integer, text, text);

-- ---------------------------------------------------------------------------
-- 1. direct_entry_list_own_submissions
-- ---------------------------------------------------------------------------
-- Keyset pagination (khong offset): order co dinh created_at DESC, submission_id DESC;
-- cursor opaque dang <yyyyMMddHH24MISSUS UTC>:<submission_id> (20 chu so) nen so sanh tuple text
-- van dung khi nhieu submission co cung created_at.
create or replace function public.direct_entry_list_own_submissions(
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
  v_own_scope_count integer;
  v_scanned integer;
  v_items jsonb;
  v_next_cursor text;
  v_has_more boolean;
begin
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'submission_create'
  );
  select count(*) into v_own_scope_count
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id
     and g.scope_kind = 'own'
     and g.team_id is null
     and g.valid_from <= public.direct_entry_authorization_date()
     and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to);
  if v_own_scope_count <> 1 then
    raise exception 'submission own scope denied' using errcode = '42501';
  end if;

  v_page_size := coalesce(p_page_size, 20);
  if v_page_size < 1 or v_page_size > 50 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  if p_state is not null and p_state not in ('DRAFT', 'REVIEW', 'SUBMITTED') then
    raise exception 'invalid submission state filter' using errcode = '22023';
  end if;
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    v_cursor_stamp := pg_catalog.split_part(p_cursor, ':', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, ':', 2)::uuid;
  end if;

  with candidates as (
    select s.submission_id,
           s.state,
           s.version,
           s.created_at,
           s.updated_at,
           s.submitted_at
      from public.direct_entry_submissions s
     where s.created_by_user_id = p_app_user_id
       and (p_state is null or s.state = p_state)
       and (
         v_cursor_stamp is null
         or (
              pg_catalog.to_char(s.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
              s.submission_id::text
            ) < (v_cursor_stamp, v_cursor_id::text)
       )
  ),
  page as (
    select c.*,
           pg_catalog.to_char(c.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
             || ':' || c.submission_id::text as cursor
      from candidates c
     order by c.created_at desc, c.submission_id desc
     limit v_page_size + 1
  ),
  trimmed as (
    select * from page order by created_at desc, submission_id desc limit v_page_size
  )
  select
    (select count(*)::int from page),
    (
      select coalesce(jsonb_agg(jsonb_build_object(
               'submission_id', t.submission_id,
               'state', t.state,
               'version', t.version,
               'entry_count', (
                 select count(*)::int from public.direct_entries e
                  where e.submission_id = t.submission_id and e.deleted_at is null
               ),
               'created_at',
                 pg_catalog.to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD')
                 || 'T' || pg_catalog.to_char(t.created_at at time zone 'UTC', 'HH24:MI:SS.US')
                 || 'Z',
               'updated_at',
                 pg_catalog.to_char(t.updated_at at time zone 'UTC', 'YYYY-MM-DD')
                 || 'T' || pg_catalog.to_char(t.updated_at at time zone 'UTC', 'HH24:MI:SS.US')
                 || 'Z',
               'submitted_at', case when t.submitted_at is null then null else
                 pg_catalog.to_char(t.submitted_at at time zone 'UTC', 'YYYY-MM-DD')
                 || 'T' || pg_catalog.to_char(t.submitted_at at time zone 'UTC', 'HH24:MI:SS.US')
                 || 'Z' end,
               'allowed_transitions', case t.state
                 when 'DRAFT' then jsonb_build_array('REVIEW')
                 when 'REVIEW' then jsonb_build_array('DRAFT', 'SUBMITTED')
                 else jsonb_build_array()
               end
             ) order by t.created_at desc, t.submission_id desc), '[]'::jsonb)
        from trimmed t
    ),
    (
      select t.cursor from trimmed t
       order by t.created_at asc, t.submission_id asc limit 1
    )
  into v_scanned, v_items, v_next_cursor;

  v_has_more := v_scanned > v_page_size;
  return jsonb_build_object(
    'items', v_items,
    'page_size', v_page_size,
    'has_more', v_has_more,
    'next_cursor', case when v_has_more then v_next_cursor else null end
  );
end;
$$;
-- ---------------------------------------------------------------------------
-- 2. direct_entry_read_own_submission
-- ---------------------------------------------------------------------------
-- Submission khong ton tai VA submission cua actor khac tra VE CUNG mot ma (P0002)
-- de chong enumeration. Khac mutation RPC (giu nguyen 42501) - day la quyet dinh co chu dich
-- cho duong doc, va khong lam thay doi authority that su (ca hai deu bi tu choi).
create or replace function public.direct_entry_read_own_submission(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_submission_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_submission public.direct_entry_submissions%rowtype;
  v_own_scope_count integer;
begin
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'submission_create'
  );
  select count(*) into v_own_scope_count
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id
     and g.scope_kind = 'own'
     and g.team_id is null
     and g.valid_from <= public.direct_entry_authorization_date()
     and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to);
  if v_own_scope_count <> 1 then
    raise exception 'submission own scope denied' using errcode = '42501';
  end if;

  if p_submission_id is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  select * into v_submission
    from public.direct_entry_submissions s
   where s.submission_id = p_submission_id;
  if not found or v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'submission_id', v_submission.submission_id,
    'state', v_submission.state,
    'version', v_submission.version,
    'entry_count', (
      select count(*)::int from public.direct_entries e
       where e.submission_id = v_submission.submission_id and e.deleted_at is null
    ),
    'entry_ids', (
      select coalesce(jsonb_agg(e.entry_id order by e.entry_id), '[]'::jsonb)
        from public.direct_entries e
       where e.submission_id = v_submission.submission_id and e.deleted_at is null
    ),
    'created_at',
      pg_catalog.to_char(v_submission.created_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_submission.created_at at time zone 'UTC', 'HH24:MI:SS.US')
      || 'Z',
    'updated_at',
      pg_catalog.to_char(v_submission.updated_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_submission.updated_at at time zone 'UTC', 'HH24:MI:SS.US')
      || 'Z',
    'submitted_at', case when v_submission.submitted_at is null then null else
      pg_catalog.to_char(v_submission.submitted_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_submission.submitted_at at time zone 'UTC', 'HH24:MI:SS.US')
      || 'Z' end,
    'allowed_transitions', case v_submission.state
      when 'DRAFT' then jsonb_build_array('REVIEW')
      when 'REVIEW' then jsonb_build_array('DRAFT', 'SUBMITTED')
      else jsonb_build_array()
    end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. ACL: hai RPC doc chi service_role; khong cap table privilege nao
-- ---------------------------------------------------------------------------
revoke all on function public.direct_entry_list_own_submissions(uuid, uuid, integer, text, text) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_read_own_submission(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_own_submissions(uuid, uuid, integer, text, text) to service_role;
grant execute on function public.direct_entry_read_own_submission(uuid, uuid, uuid) to service_role;
