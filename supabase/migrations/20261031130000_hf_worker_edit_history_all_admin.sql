-- Correct the allowlisted BoD email and search all worker revisions without requiring worker identity input.
begin;
create or replace function public.worker_edit_history_is_allowlisted_admin(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.direct_entry_app_users u
      join auth.users au on au.id = u.auth_subject
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled = true
       and pg_catalog.lower(coalesce(au.email, '')) in (
         'lienvu@hrpartner.vn',
         'ngattt@hrpartner.vn',
         'nobita6986@gmail.com'
       )
  )
  and public.direct_entry_has_scope(p_app_user_id, 'all');
$function$;
update public.direct_entry_capability_grants g
   set is_current = false
  from public.direct_entry_app_users u
  join auth.users au on au.id = u.auth_subject
 where g.app_user_id = u.app_user_id
   and g.capability = 'worker_edit_history_view'
   and g.is_current = true
   and pg_catalog.lower(coalesce(au.email, '')) = 'nobita6986@hrpartner.vn';
insert into public.direct_entry_capability_grants (
  app_user_id,
  capability,
  valid_from,
  valid_to,
  is_current
)
select u.app_user_id,
       'worker_edit_history_view',
       public.direct_entry_authorization_date(),
       null,
       true
  from public.direct_entry_app_users u
  join auth.users au on au.id = u.auth_subject
 where u.enabled = true
   and pg_catalog.lower(coalesce(au.email, '')) = 'nobita6986@gmail.com'
   and public.direct_entry_has_scope(u.app_user_id, 'all')
   and not exists (
     select 1
       from public.direct_entry_capability_grants g
      where g.app_user_id = u.app_user_id
        and g.capability = 'worker_edit_history_view'
        and g.is_current = true
   );
create or replace function public.worker_edit_history_search(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_national_id text default null,
  p_full_name text default null,
  p_from_date date default null,
  p_to_date date default null,
  p_project_query text default null,
  p_recruiter_query text default null,
  p_action_group text default null,
  p_page_size integer default 50,
  p_cursor text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_project_id text := nullif(pg_catalog.btrim(p_project_query), '');
  v_recruiter_text text := nullif(pg_catalog.btrim(p_recruiter_query), '');
  v_recruiter_id uuid;
  v_action_group text := nullif(pg_catalog.btrim(p_action_group), '');
  v_from_date date := p_from_date;
  v_to_date date := p_to_date;
  v_page_size integer := coalesce(p_page_size, 50);
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_rows jsonb := '[]'::jsonb;
  v_next_cursor text := null;
  v_has_more boolean := false;
begin
  perform public.worker_edit_history_assert_actor(p_auth_subject, p_app_user_id);

  if p_national_id is not null or p_full_name is not null then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_project_id is not null and v_project_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_recruiter_text is not null then
    begin
      v_recruiter_id := v_recruiter_text::uuid;
    exception when others then
      raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
    end;
  end if;

  if v_action_group is not null and v_action_group not in (
    'NEW_ENTRY',
    'DUPLICATE_WITHDRAWN',
    'PROFILE_EDIT',
    'STATUS_CHANGE',
    'DOCUMENT_CHANGE'
  ) then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_from_date is null or v_to_date is null
     or v_to_date < v_from_date
     or (v_to_date - v_from_date) > 92 then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_page_size not between 1 and 100 then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  if p_cursor is not null and pg_catalog.btrim(p_cursor) <> '' then
    if pg_catalog.strpos(p_cursor, '|') <= 1 then
      raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
    end if;
    begin
      v_cursor_at := pg_catalog.split_part(p_cursor, '|', 1)::timestamptz;
      v_cursor_id := pg_catalog.split_part(p_cursor, '|', 2)::uuid;
    exception when others then
      raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
    end;
  end if;

  with revision_rows as (
    select r.revision_id,
           r.entry_id,
           r.version,
           r.created_at,
           r.actor_user_id,
           coalesce(au.display_name, r.actor_user_id::text, 'Hệ thống') as actor_display_name,
           rr.reason_text,
           e.employee_code,
           coalesce(
             nullif(pg_catalog.btrim(s.after_snapshot->'worker_details'->>'display_name'), ''),
             nullif(pg_catalog.btrim(e.worker_details->>'display_name'), ''),
             '(Chưa có họ tên)'
           ) as display_name,
           coalesce(
             nullif(s.after_snapshot->'worker_details'->'national_id'->>'value', ''),
             case
               when e.worker_details->'national_id'->>'state' = 'provided'
                 then e.worker_details->'national_id'->>'value'
               else null
             end
           ) as national_id,
           e.project_id,
           coalesce(pr.display_name, e.project_id) as project_name,
           e.recruiter_id,
           coalesce(rc.display_name, e.recruiter_id::text) as recruiter_name,
           e.first_work_date,
           e.provider_type,
           e.labor_type,
           e.voided_at,
           case when s.revision_id is not null then 'COMPLETE' else 'LEGACY_LIMITED' end as snapshot_state,
           coalesce(audit_meta.actions, array[]::text[]) as audit_actions,
           coalesce(audit_meta.changed_fields, array[]::text[]) as changed_fields,
           case
             when coalesce(audit_meta.actions, array[]::text[]) && array[
               'duplicate_cccd_self_service_withdraw',
               'entry_void_apply',
               'entry_void_request'
             ]::text[]
               or coalesce(audit_meta.changed_fields, array[]::text[]) && array['ENTRY_VOID', 'voided_at']::text[]
               or (
                 s.after_snapshot->>'voided_at' is not null
                 and (s.before_snapshot is null or s.before_snapshot->>'voided_at' is null)
               )
               then 'DUPLICATE_WITHDRAWN'
             when coalesce(audit_meta.actions, array[]::text[]) && array[
               'document_direct_reserve',
               'document_direct_finalize',
               'document_reserve',
               'portrait_stage_attach'
             ]::text[]
               or coalesce(audit_meta.changed_fields, array[]::text[]) && array[
                 'document_metadata',
                 'document_lifecycle',
                 'documents'
               ]::text[]
               then 'DOCUMENT_CHANGE'
             when coalesce(audit_meta.actions, array[]::text[]) && array[
               'employment_status_apply',
               'employment_status_request',
               'employment_status_review'
             ]::text[]
               or (
                 coalesce(audit_meta.changed_fields, array[]::text[]) @> array['employment_status']::text[]
                 and pg_catalog.cardinality(coalesce(audit_meta.changed_fields, array[]::text[])) = 1
               )
               then 'STATUS_CHANGE'
             when r.version = 1 and r.before_snapshot is null
               then 'NEW_ENTRY'
             else 'PROFILE_EDIT'
           end as action_group
      from public.direct_entry_revisions r

      join public.direct_entries e on e.entry_id = r.entry_id
      left join public.direct_entry_worker_revision_snapshots s on s.revision_id = r.revision_id
      left join public.direct_entry_app_users au on au.app_user_id = r.actor_user_id
      left join public.direct_entry_restricted_reasons rr on rr.reason_id = r.reason_id
      left join public.direct_entry_projects pr on pr.project_id = e.project_id
      left join public.recruiters rc on rc.recruiter_id = e.recruiter_id
      left join lateral (
        select array_agg(distinct ae.action order by ae.action) as actions,
               array_agg(distinct cf.field_name order by cf.field_name)
                 filter (where cf.field_name is not null) as changed_fields
          from public.direct_entry_audit_events ae
          left join lateral unnest(ae.changed_fields) as cf(field_name) on true
         where ae.revision_id = r.revision_id
      ) audit_meta on true
     where (
       v_from_date is null
       or (
         r.created_at >= (v_from_date::timestamp at time zone 'Asia/Ho_Chi_Minh')
         and r.created_at < ((v_to_date + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh')
       )
     )
       and (v_project_id is null or e.project_id = v_project_id)
       and (v_recruiter_id is null or e.recruiter_id = v_recruiter_id)
       and (
         v_cursor_at is null
         or (r.created_at, r.revision_id) < (v_cursor_at, v_cursor_id)
       )
  ),
  filtered as (
    select *
      from revision_rows
     where v_action_group is null or action_group = v_action_group
     order by created_at desc, revision_id desc
     limit v_page_size + 1
  ),
  page_rows as (
    select *
      from filtered
     order by created_at desc, revision_id desc
     limit v_page_size
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'revision_id', p.revision_id,
               'entry_id', p.entry_id,
               'version', p.version,
               'created_at', p.created_at,
               'actor_user_id', p.actor_user_id,
               'actor_display_name', p.actor_display_name,
               'reason_text', p.reason_text,
               'employee_code', p.employee_code,
               'display_name', p.display_name,
               'national_id', p.national_id,
               'project_id', p.project_id,
               'project_name', p.project_name,
               'recruiter_id', p.recruiter_id,
               'recruiter_name', p.recruiter_name,
               'first_work_date', p.first_work_date,
               'provider_type', p.provider_type,
               'labor_type', p.labor_type,
               'voided_at', p.voided_at,
               'action_group', p.action_group,
               'snapshot_state', p.snapshot_state,
               'audit_actions', to_jsonb(p.audit_actions),
               'changed_fields', to_jsonb(p.changed_fields)
             )
             order by p.created_at desc, p.revision_id desc
           ),
           '[]'::jsonb
         ),
         (select count(*) > v_page_size from filtered),
         (
           select case
             when (select count(*) > v_page_size from filtered) then
               (
                 select pg_catalog.to_char(
                          last_row.created_at at time zone 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                        ) || '|' || last_row.revision_id::text
                   from page_rows last_row
                  order by last_row.created_at asc, last_row.revision_id asc
                  limit 1
               )
             else null
           end
         )
    into v_rows, v_has_more, v_next_cursor
    from page_rows p;

  return jsonb_build_object(
    'rows', v_rows,
    'has_more', v_has_more,
    'next_cursor', v_next_cursor,
    'applied_window', case
      when v_from_date is null then null
      else jsonb_build_object('from_date', v_from_date, 'to_date', v_to_date)
    end
  );
end;
$function$;
revoke all on function public.worker_edit_history_is_allowlisted_admin(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.worker_edit_history_is_allowlisted_admin(uuid, uuid) to service_role;

revoke all on function public.worker_edit_history_search(
  uuid, uuid, text, text, date, date, text, text, text, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.worker_edit_history_search(
  uuid, uuid, text, text, date, date, text, text, text, integer, text
) to service_role;

do $assert_worker_edit_history_scope$
declare
  v_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.worker_edit_history_search(uuid,uuid,text,text,date,date,text,text,text,integer,text)'::pg_catalog.regprocedure
  ) into v_definition;

  if pg_catalog.strpos(v_definition, 'matched_entries') > 0
     or pg_catalog.strpos(v_definition, 'e.project_id = v_project_id') = 0
     or pg_catalog.strpos(v_definition, 'e.recruiter_id = v_recruiter_id') = 0 then
    raise exception 'WORKER_EDIT_HISTORY_SEARCH_SCOPE_ASSERTION_FAILED';
  end if;

  if has_function_privilege('anon', 'public.worker_edit_history_search(uuid,uuid,text,text,date,date,text,text,text,integer,text)'::pg_catalog.regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated', 'public.worker_edit_history_search(uuid,uuid,text,text,date,date,text,text,text,integer,text)'::pg_catalog.regprocedure, 'EXECUTE')
     or not has_function_privilege('service_role', 'public.worker_edit_history_search(uuid,uuid,text,text,date,date,text,text,text,integer,text)'::pg_catalog.regprocedure, 'EXECUTE') then
    raise exception 'WORKER_EDIT_HISTORY_SEARCH_ACL_ASSERTION_FAILED';
  end if;

  if exists (
       select 1
         from public.direct_entry_app_users u
         join auth.users au on au.id = u.auth_subject
        where u.enabled = true
          and pg_catalog.lower(coalesce(au.email, '')) = 'nobita6986@gmail.com'
          and public.direct_entry_has_scope(u.app_user_id, 'all')
          and not public.direct_entry_has_capability(u.app_user_id, 'worker_edit_history_view')
     )
     or exists (
       select 1
         from public.direct_entry_app_users u
         join auth.users au on au.id = u.auth_subject
         join public.direct_entry_capability_grants g on g.app_user_id = u.app_user_id
        where u.enabled = true
          and pg_catalog.lower(coalesce(au.email, '')) = 'nobita6986@hrpartner.vn'
          and g.capability = 'worker_edit_history_view'
          and g.is_current = true
     ) then
    raise exception 'WORKER_EDIT_HISTORY_ADMIN_ALLOWLIST_ASSERTION_FAILED';
  end if;
end;
$assert_worker_edit_history_scope$;

commit;
