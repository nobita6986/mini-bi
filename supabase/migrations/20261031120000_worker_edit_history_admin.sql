-- Admin Worker Edit History & Missing Documents Review:
-- 1. Capability grant `worker_edit_history_view` for the 3-account Admin allowlist (`lienvu`, `ngattt`, `nobita6986`).
-- 2. Complete before/after revision snapshot storage (`public.direct_entry_worker_revision_snapshots`)
--    with triggers across `direct_entries`, `direct_entry_payments`, `direct_entry_employment_status_events`,
--    `direct_entry_document_versions`, and `direct_entry_document_events` (never exposing `storage_key`).
-- 3. Service-role-only RPCs `public.worker_edit_history_search` and `public.worker_edit_history_get_revision`.
-- 4. Service-role-only RPC `public.direct_entry_list_missing_document_workers` for the "Hồ sơ thiếu" mode
--    inside "Review thông tin NLĐ", enforcing Recruiter (view own recruited only, no upload),
--    QLDA (view managed project workers and upload, including profiles entered by another QLDA),
--    and Admin (`lienvu`, `ngattt`, `nobita6986` view all and upload), while denying other roles.

begin;

do $ensure_auth_users_email_for_pglite$
begin
  if not exists (
    select 1
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'auth'
       and c.relname = 'users'
       and a.attname = 'email'
       and a.attnum > 0
       and not a.attisdropped
  ) then
    alter table auth.users add column email text;
  end if;
end;
$ensure_auth_users_email_for_pglite$;

do $capability_constraint$
declare
  v_constraint record;
begin
  for v_constraint in
    select c.conname
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.direct_entry_capability_grants'::pg_catalog.regclass
       and c.contype = 'c'
       and pg_catalog.pg_get_constraintdef(c.oid) like '%capability%'
  loop
    execute pg_catalog.format(
      'alter table public.direct_entry_capability_grants drop constraint %I',
      v_constraint.conname
    );
  end loop;
end;
$capability_constraint$;

alter table public.direct_entry_capability_grants
  add constraint direct_entry_capability_grants_capability_check
  check (
    capability in (
      'entry_create', 'entry_own', 'entry_team', 'entry_admin',
      'entry_restore',
      'submission_create', 'change_request_create', 'change_review', 'entry_privileged_edit',
      'employment_status.request', 'employment_status.review', 'employment_status.apply',
      'document_upload', 'document_view', 'payment_view', 'payment_edit',
      'recruiter_master_manage', 'team_master_manage', 'pii_view', 'pii_export', 'audit_view',
      'catalog_master_manage', 'team_manager_assign',
      'report_form_manage', 'report_assign', 'report_view', 'report_analytics_view',
      'report_review', 'report_delegate',
      'vendor_finance_view', 'vendor_finance_record',
      'duplicate_cccd_withdraw',
      'worker_edit_history_view'
    )
  );

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
         'nobita6986@hrpartner.vn'
       )
  )
  and public.direct_entry_has_scope(p_app_user_id, 'all');
$function$;

create or replace function public.worker_edit_history_assert_actor(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if not public.worker_edit_history_is_allowlisted_admin(p_auth_subject, p_app_user_id)
     or not public.direct_entry_has_capability(p_app_user_id, 'worker_edit_history_view') then
    raise exception 'WORKER_EDIT_HISTORY_ACCESS_DENIED' using errcode = '42501';
  end if;
end;
$function$;

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
   and pg_catalog.lower(coalesce(au.email, '')) in (
     'lienvu@hrpartner.vn',
     'ngattt@hrpartner.vn',
     'nobita6986@hrpartner.vn'
   )
   and public.direct_entry_has_scope(u.app_user_id, 'all')
   and not exists (
     select 1
       from public.direct_entry_capability_grants g
      where g.app_user_id = u.app_user_id
        and g.capability = 'worker_edit_history_view'
        and g.is_current = true
   );

create table if not exists public.direct_entry_worker_revision_snapshots (
  revision_id uuid primary key
    references public.direct_entry_revisions(revision_id) on delete cascade,
  entry_id uuid not null
    references public.direct_entries(entry_id) on delete cascade,
  version integer not null check (version >= 1),
  before_snapshot jsonb,
  after_snapshot jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists direct_entry_worker_revision_snapshots_entry_version_idx
  on public.direct_entry_worker_revision_snapshots (entry_id, version desc);

create index if not exists direct_entry_revisions_created_at_id_desc_idx
  on public.direct_entry_revisions (created_at desc, revision_id desc);

create index if not exists direct_entry_audit_events_revision_id_idx
  on public.direct_entry_audit_events (revision_id)
  where revision_id is not null;

create index if not exists direct_entries_national_id_exact_idx
  on public.direct_entries ((worker_details->'national_id'->>'value'))
  where worker_details->'national_id'->>'state' = 'provided';

create index if not exists direct_entries_display_name_exact_idx
  on public.direct_entries ((pg_catalog.lower(pg_catalog.btrim(coalesce(worker_details->>'display_name', '')))));

alter table public.direct_entry_worker_revision_snapshots enable row level security;
alter table public.direct_entry_worker_revision_snapshots force row level security;

revoke all on table public.direct_entry_worker_revision_snapshots
  from public, anon, authenticated, service_role;

drop trigger if exists direct_entry_worker_revision_snapshots_immutable
  on public.direct_entry_worker_revision_snapshots;

create trigger direct_entry_worker_revision_snapshots_immutable
  before update or delete on public.direct_entry_worker_revision_snapshots
  for each row execute function public.direct_entry_reject_immutable_change();

create or replace function public.worker_edit_history_snapshot(p_entry_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select case
    when e.entry_id is null then null
    else jsonb_build_object(
      'entry_id', e.entry_id,
      'submission_id', e.submission_id,
      'candidate_id', e.candidate_id,
      'created_by_user_id', e.created_by_user_id,
      'project_id', e.project_id,
      'project_name', coalesce(pr.display_name, e.project_id),
      'first_work_date', e.first_work_date,
      'employee_code', e.employee_code,
      'worker_details', e.worker_details,
      'general_note', e.general_note,
      'recruiter_id', e.recruiter_id,
      'recruiter_name', coalesce(rc.display_name, e.recruiter_id::text),
      'team_id', e.team_id,
      'provider_type', e.provider_type,
      'labor_type', e.labor_type,
      'version', e.version,
      'deleted_at', e.deleted_at,
      'voided_at', e.voided_at,
      'voided_by_user_id', e.voided_by_user_id,
      'employment_status', (
        select jsonb_build_object(
          'event_id', st.event_id,
          'status', st.status,
          'effective_date', st.effective_date,
          'leave_date', st.leave_date,
          'leave_reason_text', st.leave_reason_text,
          'version', st.version,
          'actor_user_id', st.actor_user_id,
          'actor_display_name', coalesce(stu.display_name, st.actor_user_id::text),
          'created_at', st.applied_at
        )
          from public.direct_entry_employment_status_events st
          left join public.direct_entry_app_users stu on stu.app_user_id = st.actor_user_id
         where st.entry_id = e.entry_id
         order by st.version desc
         limit 1
      ),
      'payment', case
        when p.entry_id is null then null
        else jsonb_build_object(
          'state', p.state,
          'account_number', p.account_number,
          'bank_id', p.bank_id,
          'bank_name', coalesce(nullif(pg_catalog.btrim(p.bank_name), ''), b.display_name),
          'account_holder_name', p.account_holder_name,
          'version', p.version,
          'updated_at', p.updated_at
        )
      end,
      'documents', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'document_id', d.document_id,
            'document_type', d.document_type,
            'version', d.version,
            'size_bytes', d.size_bytes,
            'mime_type', d.mime_type,
            'upload_status', latest.upload_status,
            'scan_status', latest.scan_status,
            'validation_status', latest.validation_status,
            'created_by_user_id', d.created_by_user_id,
            'uploader_display_name', coalesce(du.display_name, d.created_by_user_id::text),
            'supersedes_document_id', d.supersedes_document_id,
            'created_at', d.created_at,
            'updated_at', latest.created_at
          )
          order by d.document_type, d.version
        )
          from public.direct_entry_document_versions d
          left join public.direct_entry_app_users du on du.app_user_id = d.created_by_user_id
          join lateral (
            select ev.upload_status, ev.scan_status, ev.validation_status, ev.created_at
              from public.direct_entry_document_events ev
             where ev.document_id = d.document_id
             order by ev.version desc
             limit 1
          ) latest on true
         where d.candidate_id = e.candidate_id
      ), '[]'::jsonb)
    )
  end
  from public.direct_entries e
  left join public.direct_entry_projects pr on pr.project_id = e.project_id
  left join public.recruiters rc on rc.recruiter_id = e.recruiter_id
  left join public.direct_entry_payments p on p.entry_id = e.entry_id
  left join public.direct_entry_banks b on b.bank_id = p.bank_id
 where e.entry_id = p_entry_id;
$function$;

create or replace function public.direct_entry_worker_edit_history_capture_before()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry_id uuid;
  v_candidate_id uuid;
  v_document_id uuid;
  v_key text;
  v_snapshot jsonb;
begin
  if tg_table_name = 'direct_entries' then
    v_entry_id := case when tg_op = 'INSERT' then null else old.entry_id end;
  elsif tg_table_name in ('direct_entry_payments', 'direct_entry_employment_status_events') then
    v_entry_id := case when tg_op = 'INSERT' then new.entry_id else old.entry_id end;
  elsif tg_table_name = 'direct_entry_document_versions' then
    v_candidate_id := case when tg_op = 'INSERT' then new.candidate_id else old.candidate_id end;
    select e.entry_id into v_entry_id
      from public.direct_entries e
     where e.candidate_id = v_candidate_id
     order by e.created_at desc
     limit 1;
  elsif tg_table_name = 'direct_entry_document_events' then
    v_document_id := case when tg_op = 'INSERT' then new.document_id else old.document_id end;
    select e.entry_id into v_entry_id
      from public.direct_entry_document_versions d
      join public.direct_entries e on e.candidate_id = d.candidate_id
     where d.document_id = v_document_id
     order by e.created_at desc
     limit 1;
  end if;

  if v_entry_id is not null then
    v_key := 'bi.worker_edit_history_before_' || replace(v_entry_id::text, '-', '');
    if nullif(pg_catalog.current_setting(v_key, true), '') is null then
      v_snapshot := public.worker_edit_history_snapshot(v_entry_id);
      if v_snapshot is not null then
        perform pg_catalog.set_config(v_key, v_snapshot::text, true);
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

drop trigger if exists direct_entry_worker_edit_history_capture_before_entries
  on public.direct_entries;
create trigger direct_entry_worker_edit_history_capture_before_entries
  before update on public.direct_entries
  for each row execute function public.direct_entry_worker_edit_history_capture_before();

drop trigger if exists direct_entry_worker_edit_history_capture_before_payments
  on public.direct_entry_payments;
create trigger direct_entry_worker_edit_history_capture_before_payments
  before insert or update on public.direct_entry_payments
  for each row execute function public.direct_entry_worker_edit_history_capture_before();

drop trigger if exists direct_entry_worker_edit_history_capture_before_status_events
  on public.direct_entry_employment_status_events;
create trigger direct_entry_worker_edit_history_capture_before_status_events
  before insert on public.direct_entry_employment_status_events
  for each row execute function public.direct_entry_worker_edit_history_capture_before();

drop trigger if exists direct_entry_worker_edit_history_capture_before_document_versions
  on public.direct_entry_document_versions;
create trigger direct_entry_worker_edit_history_capture_before_document_versions
  before insert on public.direct_entry_document_versions
  for each row execute function public.direct_entry_worker_edit_history_capture_before();

drop trigger if exists direct_entry_worker_edit_history_capture_before_document_events
  on public.direct_entry_document_events;
create trigger direct_entry_worker_edit_history_capture_before_document_events
  before insert on public.direct_entry_document_events
  for each row execute function public.direct_entry_worker_edit_history_capture_before();

create or replace function public.direct_entry_write_revision(
  p_entry_id uuid,
  p_app_user_id uuid,
  p_reason_id uuid,
  p_before jsonb,
  p_after jsonb,
  p_version integer
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_revision_id uuid;
  v_key text := 'bi.worker_edit_history_before_' || replace(p_entry_id::text, '-', '');
  v_captured_before text;
  v_before_full jsonb;
  v_after_full jsonb;
begin
  insert into public.direct_entry_revisions (
    entry_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
  ) values (
    p_entry_id,
    p_version,
    p_app_user_id,
    p_reason_id,
    p_before,
    p_after
  )
  returning revision_id into v_revision_id;

  v_captured_before := nullif(pg_catalog.current_setting(v_key, true), '');
  if p_before is not null then
    if v_captured_before is not null then
      v_before_full := v_captured_before::jsonb;
    else
      v_before_full := p_before;
    end if;
  else
    v_before_full := null;
  end if;

  v_after_full := coalesce(public.worker_edit_history_snapshot(p_entry_id), p_after, '{}'::jsonb);

  insert into public.direct_entry_worker_revision_snapshots (
    revision_id, entry_id, version, before_snapshot, after_snapshot
  ) values (
    v_revision_id, p_entry_id, p_version, v_before_full, v_after_full
  );

  perform pg_catalog.set_config(v_key, '', true);
  return v_revision_id;
end;
$function$;

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
  v_national_id text := nullif(pg_catalog.btrim(p_national_id), '');
  v_full_name text := nullif(pg_catalog.btrim(p_full_name), '');
  v_project_query text := nullif(pg_catalog.btrim(p_project_query), '');
  v_recruiter_query text := nullif(pg_catalog.btrim(p_recruiter_query), '');
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

  if (v_national_id is null) = (v_full_name is null) then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_national_id is not null and (v_national_id !~ '^[0-9]{12}$' or v_national_id = '000000000000') then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_full_name is not null and (
    pg_catalog.char_length(v_full_name) not between 2 and 120
    or v_full_name ~ '[[:cntrl:]]'
  ) then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_project_query is not null and (
    pg_catalog.char_length(v_project_query) > 120
    or v_project_query ~ '[[:cntrl:]]'
  ) then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_recruiter_query is not null and (
    pg_catalog.char_length(v_recruiter_query) > 120
    or v_recruiter_query ~ '[[:cntrl:]]'
  ) then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
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

  if (v_from_date is null) <> (v_to_date is null) then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_full_name is not null and v_from_date is null and v_to_date is null then
    v_to_date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
    v_from_date := v_to_date - 29;
  end if;

  if v_from_date is not null and v_to_date is not null then
    if v_to_date < v_from_date or (v_to_date - v_from_date) > 92 then
      raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
    end if;
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

  with matched_entries as (
    select e.entry_id
      from public.direct_entries e
     where (
       v_national_id is not null
       and e.worker_details->'national_id'->>'state' = 'provided'
       and e.worker_details->'national_id'->>'value' = v_national_id
     )
     or (
       v_full_name is not null
       and pg_catalog.lower(pg_catalog.btrim(coalesce(e.worker_details->>'display_name', '')))
           = pg_catalog.lower(v_full_name)
     )
    union
    select r.entry_id
      from public.direct_entry_revisions r
     where (
       v_national_id is not null
       and (
         r.before_snapshot->'worker_details'->'national_id'->>'value' = v_national_id
         or r.after_snapshot->'worker_details'->'national_id'->>'value' = v_national_id
       )
     )
     or (
       v_full_name is not null
       and (
         pg_catalog.lower(pg_catalog.btrim(coalesce(r.before_snapshot->'worker_details'->>'display_name', '')))
           = pg_catalog.lower(v_full_name)
         or pg_catalog.lower(pg_catalog.btrim(coalesce(r.after_snapshot->'worker_details'->>'display_name', '')))
           = pg_catalog.lower(v_full_name)
       )
     )
    union
    select s.entry_id
      from public.direct_entry_worker_revision_snapshots s
     where (
       v_national_id is not null
       and (
         s.before_snapshot->'worker_details'->'national_id'->>'value' = v_national_id
         or s.after_snapshot->'worker_details'->'national_id'->>'value' = v_national_id
       )
     )
     or (
       v_full_name is not null
       and (
         pg_catalog.lower(pg_catalog.btrim(coalesce(s.before_snapshot->'worker_details'->>'display_name', '')))
           = pg_catalog.lower(v_full_name)
         or pg_catalog.lower(pg_catalog.btrim(coalesce(s.after_snapshot->'worker_details'->>'display_name', '')))
           = pg_catalog.lower(v_full_name)
       )
     )
  ),
  revision_rows as (
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
      join matched_entries me on me.entry_id = r.entry_id
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
       and (
         v_project_query is null
         or pg_catalog.strpos(pg_catalog.lower(coalesce(pr.display_name, e.project_id)), pg_catalog.lower(v_project_query)) > 0
         or pg_catalog.strpos(pg_catalog.lower(e.project_id), pg_catalog.lower(v_project_query)) > 0
       )
       and (
         v_recruiter_query is null
         or pg_catalog.strpos(pg_catalog.lower(coalesce(rc.display_name, '')), pg_catalog.lower(v_recruiter_query)) > 0
       )
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

create or replace function public.worker_edit_history_get_revision(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_revision_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_rev public.direct_entry_revisions%rowtype;
  v_entry public.direct_entries%rowtype;
  v_snap public.direct_entry_worker_revision_snapshots%rowtype;
  v_has_snap boolean := false;
  v_actor_name text;
  v_reason_text text;
  v_audit_events jsonb;
  v_status_events jsonb;
  v_document_events jsonb;
begin
  perform public.worker_edit_history_assert_actor(p_auth_subject, p_app_user_id);

  if p_entry_id is null or p_revision_id is null then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  select * into v_rev
    from public.direct_entry_revisions r
   where r.revision_id = p_revision_id
     and r.entry_id = p_entry_id;
  if not found then
    raise exception 'WORKER_EDIT_HISTORY_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id;
  if not found then
    raise exception 'WORKER_EDIT_HISTORY_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_snap
    from public.direct_entry_worker_revision_snapshots s
   where s.revision_id = p_revision_id;
  v_has_snap := found;

  select coalesce(u.display_name, v_rev.actor_user_id::text, 'Hệ thống')
    into v_actor_name
    from (select 1) one
    left join public.direct_entry_app_users u on u.app_user_id = v_rev.actor_user_id;

  select rr.reason_text
    into v_reason_text
    from public.direct_entry_restricted_reasons rr
   where rr.reason_id = v_rev.reason_id;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'event_id', ae.event_id,
               'action', ae.action,
               'capability', ae.capability,
               'scope_kind', ae.scope_kind,
               'outcome', ae.outcome,
               'actor_user_id', ae.app_user_id,
               'actor_display_name', coalesce(au.display_name, ae.app_user_id::text, 'Hệ thống'),
               'reason_text', rr.reason_text,
               'changed_fields', to_jsonb(ae.changed_fields),
               'created_at', ae.created_at
             )
             order by ae.created_at asc, ae.event_id asc
           ),
           '[]'::jsonb
         )
    into v_audit_events
    from public.direct_entry_audit_events ae
    left join public.direct_entry_app_users au on au.app_user_id = ae.app_user_id
    left join public.direct_entry_restricted_reasons rr on rr.reason_id = ae.reason_id
   where ae.revision_id = p_revision_id;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'event_id', st.event_id,
               'status', st.status,
               'effective_date', st.effective_date,
               'leave_date', st.leave_date,
               'leave_reason_text', st.leave_reason_text,
               'version', st.version,
               'actor_user_id', st.actor_user_id,
               'actor_display_name', coalesce(stu.display_name, st.actor_user_id::text, 'Hệ thống'),
               'reason_text', rr.reason_text,
               'created_at', st.applied_at
             )
             order by st.version desc
           ),
           '[]'::jsonb
         )
    into v_status_events
    from public.direct_entry_employment_status_events st
    left join public.direct_entry_app_users stu on stu.app_user_id = st.actor_user_id
    left join public.direct_entry_restricted_reasons rr on rr.reason_id = st.reason_id
   where st.entry_id = p_entry_id
     and (v_rev.reason_id is not null and st.reason_id = v_rev.reason_id or v_rev.version = 1);

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'document_id', d.document_id,
               'document_type', d.document_type,
               'version', d.version,
               'size_bytes', d.size_bytes,
               'mime_type', d.mime_type,
               'upload_status', d.upload_status,
               'scan_status', d.scan_status,
               'created_by_user_id', d.created_by_user_id,
               'uploader_display_name', coalesce(du.display_name, d.created_by_user_id::text, 'Hệ thống'),
               'supersedes_document_id', d.supersedes_document_id,
               'created_at', ev.created_at,
               'event_version', ev.version,
               'event_status', ev.upload_status,
               'validation_status', ev.validation_status
             )
             order by ev.created_at desc, d.document_type asc, d.version desc
           ),
           '[]'::jsonb
         )
    into v_document_events
    from public.direct_entry_document_versions d
    join public.direct_entry_document_events ev on ev.document_id = d.document_id
    left join public.direct_entry_app_users du on du.app_user_id = d.created_by_user_id
   where d.candidate_id = v_entry.candidate_id;

  return jsonb_build_object(
    'revision_id', v_rev.revision_id,
    'entry_id', v_rev.entry_id,
    'version', v_rev.version,
    'created_at', v_rev.created_at,
    'actor_user_id', v_rev.actor_user_id,
    'actor_display_name', v_actor_name,
    'reason_text', v_reason_text,
    'snapshot_state', case when v_has_snap then 'COMPLETE' else 'LEGACY_LIMITED' end,
    'before_snapshot', case when v_has_snap then v_snap.before_snapshot else v_rev.before_snapshot end,
    'after_snapshot', case when v_has_snap then v_snap.after_snapshot else v_rev.after_snapshot end,
    'current_snapshot', public.worker_edit_history_snapshot(p_entry_id),
    'audit_events', v_audit_events,
    'employment_status_events', v_status_events,
    'document_events', v_document_events
  );
end;
$function$;

-- Keep direct-edit authority tied to the existing full-admin and scoped grants; the history allowlist
-- must not become a general worker-edit grant.
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
  if p_is_full_admin then
    return 'admin_all';
  end if;

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

revoke all on function public.direct_entry_resolve_direct_edit_authority(
  uuid, uuid, uuid, uuid, text, boolean, uuid
) from public, anon, authenticated, service_role;

-- Allow assigned QLDA and 3-Admin allowlist with `document_upload` capability to upload
-- missing documents on both DRAFT and SUBMITTED entries (including entries created by another QLDA),
-- while keeping non-authorized actors fail-closed.
do $patch_document_upload_cross_creator_draft_and_submitted$
declare
  v_signature regprocedure :=
    'public.direct_entry_assert_document_upload_access(uuid,uuid,uuid)'::regprocedure;
  v_before_owner oid;
  v_before_acl aclitem[];
  v_before_secdef boolean;
  v_before_config text[];
  v_source text;
  v_definition text;
  v_next text;
  v_old text;
  v_new text;
begin
  select p.proowner, p.proacl, p.prosecdef, p.proconfig, p.prosrc, pg_catalog.pg_get_functiondef(p.oid)
    into v_before_owner, v_before_acl, v_before_secdef, v_before_config, v_source, v_definition
    from pg_catalog.pg_proc p
   where p.oid = v_signature;

  v_next := replace(v_source, E'\r\n', E'\n');

  if position('v_submission_state in (''DRAFT'', ''SUBMITTED'')' in v_next) = 0 then
    v_old := $old$      if v_entry.created_by_user_id = p_app_user_id
         and public.direct_entry_actor_can_access_project(
           p_app_user_id, v_entry.project_id
         ) then
        return 'project';
      end if;
      raise;
    end;
  end if;$old$;
    v_new := $new$      if v_entry.created_by_user_id = p_app_user_id
         and public.direct_entry_actor_can_access_project(
           p_app_user_id, v_entry.project_id
         ) then
        return 'project';
      end if;
      if v_entry.created_by_user_id = p_app_user_id then
        raise;
      end if;
    end;
  end if;$new$;
    if position(v_old in v_next) = 0 then
      raise exception 'Missing documents draft cross-creator drift in direct_entry_assert_document_upload_access' using errcode = '55000';
    end if;
    v_next := replace(v_next, v_old, v_new);

    v_old := $old$  if v_submission_state = 'SUBMITTED' then
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'document_upload'
    );$old$;
    v_new := $new$  if v_submission_state in ('DRAFT', 'SUBMITTED') then
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'document_upload'
    );$new$;
    if position(v_old in v_next) = 0 then
      raise exception 'Missing documents direct edit authority state drift in direct_entry_assert_document_upload_access' using errcode = '55000';
    end if;
    v_next := replace(v_next, v_old, v_new);

    execute replace(replace(v_definition, E'\r\n', E'\n'), replace(v_source, E'\r\n', E'\n'), v_next);
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.oid = v_signature
       and p.proowner = v_before_owner
       and p.proacl is not distinct from v_before_acl
       and p.prosecdef is not distinct from v_before_secdef
       and p.proconfig is not distinct from v_before_config
  ) then
    raise exception 'Missing documents patch changed security metadata on direct_entry_assert_document_upload_access' using errcode = '55000';
  end if;
end;
$patch_document_upload_cross_creator_draft_and_submitted$;

-- Ensure a Recruiter (who has neither Admin allowlist/full-admin authority, nor assigned QLDA authority
-- on the entry's project, nor Team Leader / privileged-edit authority) cannot upload documents with a reason
-- on SUBMITTED entries or from "Hồ sơ thiếu".
do $patch_reserve_recruiter_upload_guard$
declare
  v_signature regprocedure :=
    'public.direct_entry_reserve_document_direct_upload(uuid,uuid,uuid,integer,text,text,bigint,text,text)'::regprocedure;
  v_before_owner oid;
  v_before_acl aclitem[];
  v_before_secdef boolean;
  v_before_config text[];
  v_source text;
  v_definition text;
  v_next text;
  v_old text;
  v_new text;
begin
  select p.proowner, p.proacl, p.prosecdef, p.proconfig, p.prosrc, pg_catalog.pg_get_functiondef(p.oid)
    into v_before_owner, v_before_acl, v_before_secdef, v_before_config, v_source, v_definition
    from pg_catalog.pg_proc p
   where p.oid = v_signature;

  v_next := replace(v_source, E'\r\n', E'\n');

  if position('missing document upload denied for recruiter' in v_next) = 0 then
    v_old := $old$  select state into v_submission_state
    from public.direct_entry_submissions
   where submission_id = v_entry.submission_id;$old$;
    v_new := v_old || E'\n' || $new$  if (v_submission_state = 'SUBMITTED' and p_reason is not null)
     or (p_reason is not null and p_reason ilike '%hồ sơ còn thiếu%') then
    if not public.worker_edit_history_is_allowlisted_admin(p_auth_subject, p_app_user_id)
       and not public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, v_entry.project_id)
       and v_scope not in ('all', 'project', 'team')
       and not public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit') then
      raise exception 'missing document upload denied for recruiter' using errcode = '42501';
    end if;
  end if;$new$;
    if position(v_old in v_next) = 0 then
      raise exception 'Missing documents guard drift in direct_entry_reserve_document_direct_upload' using errcode = '55000';
    end if;
    v_next := replace(v_next, v_old, v_new);
    execute replace(replace(v_definition, E'\r\n', E'\n'), replace(v_source, E'\r\n', E'\n'), v_next);
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.oid = v_signature
       and p.proowner = v_before_owner
       and p.proacl is not distinct from v_before_acl
       and p.prosecdef is not distinct from v_before_secdef
       and p.proconfig is not distinct from v_before_config
  ) then
    raise exception 'Missing documents guard changed security metadata on direct_entry_reserve_document_direct_upload' using errcode = '55000';
  end if;
end;
$patch_reserve_recruiter_upload_guard$;

-- Service-role RPC for "Hồ sơ thiếu" inside "Review thông tin NLĐ":
-- - Admin (`lienvu`, `ngattt`, `nobita6986` with `all` scope): views all (`scope_kind = 'all'`), `can_upload = true`.
-- - QLDA (assigned Project Manager): views managed projects (`scope_kind = 'project'`), `can_upload = true` (even if entered by another QLDA).
-- - Người tuyển (Recruiter): views own recruited workers (`scope_kind = 'recruited'`), `can_upload = false`.
-- - Other roles: denied with 42501 (`MISSING_DOCUMENTS_ACCESS_DENIED`).
-- - Only includes non-deleted, non-voided entries in `DRAFT` or `SUBMITTED` state whose current employment status is `ON` or `UNCONFIRMED` and missing >= 1 of the 4 required documents.
create or replace function public.direct_entry_list_missing_document_workers(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_missing_type text default null,
  p_project_id text default null,
  p_employment_status text default null,
  p_search text default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_missing_type text := coalesce(nullif(pg_catalog.upper(pg_catalog.btrim(p_missing_type)), ''), 'ALL');
  v_employment_status text := coalesce(nullif(pg_catalog.upper(pg_catalog.btrim(p_employment_status)), ''), 'ALL');
  v_project_id text := nullif(pg_catalog.btrim(p_project_id), '');
  v_search text := nullif(pg_catalog.btrim(p_search), '');
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_offset integer;
  v_is_allowlisted_admin boolean := false;
  v_managed_project_ids text[] := array[]::text[];
  v_recruiter_ids uuid[] := array[]::uuid[];
  v_scope_kind text;
  v_can_upload boolean := false;
  v_summary jsonb;
  v_project_options jsonb;
  v_total_count integer := 0;
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
begin
  if v_missing_type not in ('ALL', 'WORKER_PORTRAIT', 'CCCD_FRONT', 'CCCD_BACK', 'EMPLOYMENT_CONTRACT') then
    raise exception 'MISSING_DOCUMENTS_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_employment_status not in ('ALL', 'ON', 'UNCONFIRMED') then
    raise exception 'MISSING_DOCUMENTS_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_project_id is not null and (
    pg_catalog.char_length(v_project_id) > 128
    or v_project_id ~ '[[:cntrl:]]'
  ) then
    raise exception 'MISSING_DOCUMENTS_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_search is not null and (
    pg_catalog.char_length(v_search) > 100
    or v_search ~ '[[:cntrl:]]'
  ) then
    raise exception 'MISSING_DOCUMENTS_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_page < 1 or v_page > 1000 or v_page_size < 1 or v_page_size > 100 then
    raise exception 'MISSING_DOCUMENTS_QUERY_INVALID' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  v_is_allowlisted_admin := public.worker_edit_history_is_allowlisted_admin(p_auth_subject, p_app_user_id);

  select coalesce(array_agg(distinct pma.project_id order by pma.project_id), array[]::text[])
    into v_managed_project_ids
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r
      on r.recruiter_id = l.recruiter_id
     and r.active
    join public.direct_entry_project_manager_assignments pma
      on pma.manager_recruiter_id = l.recruiter_id
     and pma.is_current
     and pma.revoked_at is null
    join public.direct_entry_projects pr
      on pr.project_id = pma.project_id
     and pr.active
   where l.app_user_id = p_app_user_id
     and l.verified
     and l.is_current;

  select coalesce(array_agg(distinct l.recruiter_id order by l.recruiter_id), array[]::uuid[])
    into v_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r
      on r.recruiter_id = l.recruiter_id
     and r.active
   where l.app_user_id = p_app_user_id
     and l.verified
     and l.is_current;

  if v_is_allowlisted_admin then
    v_scope_kind := 'all';
    v_can_upload := public.direct_entry_has_capability(p_app_user_id, 'document_upload');
  elsif pg_catalog.cardinality(v_managed_project_ids) > 0 then
    v_scope_kind := 'project';
    v_can_upload := public.direct_entry_has_capability(p_app_user_id, 'document_upload');
  elsif pg_catalog.cardinality(v_recruiter_ids) > 0 then
    v_scope_kind := 'recruited';
    v_can_upload := false;
  else
    raise exception 'MISSING_DOCUMENTS_ACCESS_DENIED' using errcode = '42501';
  end if;

  with eligible_entries as (
    select e.entry_id,
           e.version as entry_version,
           e.candidate_id,
           e.submission_id,
           e.project_id,
           coalesce(pr.display_name, e.project_id) as project_display,
           e.recruiter_id,
           coalesce(rc.display_name, '') as recruiter_display,
           e.first_work_date,
           e.employee_code,
           e.worker_details,
           e.created_by_user_id,
           coalesce(creator.display_name, '') as created_by_display,
           coalesce(st.status, 'UNCONFIRMED') as employment_status,
           coalesce(
             nullif(pg_catalog.btrim(e.worker_details->>'display_name'), ''),
             '(Chưa có họ tên)'
           ) as display_name,
           case
             when e.worker_details->'national_id'->>'state' = 'provided'
               then e.worker_details->'national_id'->>'value'
             else null
           end as national_id,
           array_remove(array[
             case when not exists (
               select 1
                 from public.direct_entry_current_documents cd
                where cd.candidate_id = e.candidate_id
                  and cd.document_type = 'WORKER_PORTRAIT'
             ) then 'WORKER_PORTRAIT' end,
             case when not exists (
               select 1
                 from public.direct_entry_current_documents cd
                where cd.candidate_id = e.candidate_id
                  and cd.document_type = 'CCCD_FRONT'
             ) then 'CCCD_FRONT' end,
             case when not exists (
               select 1
                 from public.direct_entry_current_documents cd
                where cd.candidate_id = e.candidate_id
                  and cd.document_type = 'CCCD_BACK'
             ) then 'CCCD_BACK' end,
             case when not exists (
               select 1
                 from public.direct_entry_current_documents cd
                where cd.candidate_id = e.candidate_id
                  and cd.document_type = 'EMPLOYMENT_CONTRACT'
             ) then 'EMPLOYMENT_CONTRACT' end
           ], null) as missing_documents
      from public.direct_entries e
      join public.direct_entry_submissions s
        on s.submission_id = e.submission_id
       and s.state in ('DRAFT', 'SUBMITTED')
      left join public.direct_entry_projects pr
        on pr.project_id = e.project_id
      left join public.recruiters rc
        on rc.recruiter_id = e.recruiter_id
      left join public.direct_entry_app_users creator
        on creator.app_user_id = e.created_by_user_id
      left join lateral (
        select ev.status
          from public.direct_entry_employment_status_events ev
         where ev.entry_id = e.entry_id
         order by ev.version desc
         limit 1
      ) st on true
     where e.deleted_at is null
       and e.voided_at is null
       and coalesce(st.status, 'UNCONFIRMED') in ('ON', 'UNCONFIRMED')
       and (
         (v_scope_kind = 'all')
         or (v_scope_kind = 'project' and e.project_id = any(v_managed_project_ids))
         or (v_scope_kind = 'recruited' and e.recruiter_id = any(v_recruiter_ids))
       )
  ),
  missing_only as (
    select ee.*
      from eligible_entries ee
     where pg_catalog.cardinality(ee.missing_documents) > 0
  ),
  base_filtered as (
    select m.*
      from missing_only m
     where (v_project_id is null or m.project_id = v_project_id)
       and (v_employment_status = 'ALL' or m.employment_status = v_employment_status)
       and (
         v_search is null
         or pg_catalog.strpos(pg_catalog.lower(m.display_name), pg_catalog.lower(v_search)) > 0
         or pg_catalog.strpos(pg_catalog.lower(coalesce(m.national_id, '')), pg_catalog.lower(v_search)) > 0
         or pg_catalog.strpos(pg_catalog.lower(coalesce(m.employee_code, '')), pg_catalog.lower(v_search)) > 0
       )
  ),
  type_filtered as (
    select bf.*
      from base_filtered bf
     where v_missing_type = 'ALL' or v_missing_type = any(bf.missing_documents)
  ),
  paged as (
    select tf.*
      from type_filtered tf
     order by tf.first_work_date desc, tf.entry_id asc
     limit v_page_size + 1
    offset v_offset
  ),
  page_rows as (
    select *
      from paged
     order by first_work_date desc, entry_id asc
     limit v_page_size
  )
  select jsonb_build_object(
           'total_workers', count(*)::int,
           'missing_worker_portrait', count(*) filter (where 'WORKER_PORTRAIT' = any(bf.missing_documents))::int,
           'missing_cccd_front', count(*) filter (where 'CCCD_FRONT' = any(bf.missing_documents))::int,
           'missing_cccd_back', count(*) filter (where 'CCCD_BACK' = any(bf.missing_documents))::int,
           'missing_employment_contract', count(*) filter (where 'EMPLOYMENT_CONTRACT' = any(bf.missing_documents))::int
         ),
         coalesce((select count(*)::int from type_filtered), 0),
         coalesce((select count(*) > v_page_size from paged), false),
         coalesce((
           select jsonb_agg(
                    jsonb_build_object(
                      'project_id', po.project_id,
                      'project_display', po.project_display
                    )
                    order by po.project_display asc, po.project_id asc
                  )
             from (
               select distinct m.project_id, m.project_display
                 from missing_only m
             ) po
         ), '[]'::jsonb),
         coalesce((
           select jsonb_agg(item_row.item_json order by item_row.ord)
             from (
               select row_number() over (order by pr.first_work_date desc, pr.entry_id asc) as ord,
                      jsonb_build_object(
                        'entry_id', pr.entry_id,
                        'entry_version', pr.entry_version,
                        'employee_code', pr.employee_code,
                        'display_name', pr.display_name,
                        'national_id', pr.national_id,
                        'project_id', pr.project_id,
                        'project_display', pr.project_display,
                        'recruiter_id', pr.recruiter_id,
                        'recruiter_display', pr.recruiter_display,
                        'first_work_date', pg_catalog.to_char(pr.first_work_date, 'YYYY-MM-DD'),
                        'employment_status', pr.employment_status,
                        'created_by_user_id', pr.created_by_user_id,
                        'created_by_display', pr.created_by_display,
                        'missing_documents', to_jsonb(pr.missing_documents),
                        'can_upload', v_can_upload,
                        'documents', coalesce((
                          select jsonb_agg(
                                   jsonb_build_object(
                                     'document_id', cd.document_id,
                                     'document_type', cd.document_type,
                                     'document_version', cd.version,
                                     'mime_type', cd.mime_type,
                                     'size_bytes', cd.size_bytes,
                                     'updated_at', pg_catalog.to_char(cd.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                                   )
                                   order by
                                     case cd.document_type
                                       when 'WORKER_PORTRAIT' then 0
                                       when 'CCCD_FRONT' then 1
                                       when 'CCCD_BACK' then 2
                                       else 3
                                     end asc
                                 )
                            from public.direct_entry_current_documents cd
                           where cd.candidate_id = pr.candidate_id
                             and cd.document_type in ('WORKER_PORTRAIT', 'CCCD_FRONT', 'CCCD_BACK', 'EMPLOYMENT_CONTRACT')
                        ), '[]'::jsonb)
                      ) as item_json
                 from page_rows pr
             ) item_row
         ), '[]'::jsonb)
    into v_summary, v_total_count, v_has_more, v_project_options, v_items
    from base_filtered bf;

  return jsonb_build_object(
    'scope_kind', v_scope_kind,
    'can_upload', v_can_upload,
    'filter_missing_type', v_missing_type,
    'filter_employment_status', v_employment_status,
    'filter_project_id', v_project_id,
    'filter_search', v_search,
    'page', v_page,
    'page_size', v_page_size,
    'total_count', v_total_count,
    'has_more', v_has_more,
    'summary', coalesce(v_summary, jsonb_build_object(
      'total_workers', 0,
      'missing_worker_portrait', 0,
      'missing_cccd_front', 0,
      'missing_cccd_back', 0,
      'missing_employment_contract', 0
    )),
    'project_options', coalesce(v_project_options, '[]'::jsonb),
    'items', coalesce(v_items, '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.worker_edit_history_is_allowlisted_admin(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.worker_edit_history_assert_actor(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.worker_edit_history_snapshot(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_worker_edit_history_capture_before()
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_write_revision(uuid, uuid, uuid, jsonb, jsonb, integer)
  from public, anon, authenticated, service_role;

revoke all on function public.worker_edit_history_search(
  uuid, uuid, text, text, date, date, text, text, text, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.worker_edit_history_search(
  uuid, uuid, text, text, date, date, text, text, text, integer, text
) to service_role;

revoke all on function public.worker_edit_history_get_revision(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.worker_edit_history_get_revision(
  uuid, uuid, uuid, uuid
) to service_role;

revoke all on function public.direct_entry_list_missing_document_workers(
  uuid, uuid, text, text, text, text, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_missing_document_workers(
  uuid, uuid, text, text, text, text, integer, integer
) to service_role;

do $align_owners$
declare
  v_table_owner_oid oid;
  v_table_owner name;
  v_snap_owner_oid oid;
  v_sig text;
  v_proc_owner_oid oid;
  v_owner name;
begin
  select c.relowner, r.rolname
    into v_table_owner_oid, v_table_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entries'::pg_catalog.regclass;

  select c.relowner
    into v_snap_owner_oid
    from pg_catalog.pg_class c
   where c.oid = 'public.direct_entry_worker_revision_snapshots'::pg_catalog.regclass;

  if v_table_owner_oid is not null
     and v_snap_owner_oid is distinct from v_table_owner_oid
     and pg_catalog.pg_has_role(current_user, v_table_owner_oid, 'SET') then
    execute pg_catalog.format(
      'alter table public.direct_entry_worker_revision_snapshots owner to %I',
      v_table_owner
    );
  end if;

  foreach v_sig in array array[
    'public.worker_edit_history_is_allowlisted_admin(uuid,uuid)',
    'public.worker_edit_history_assert_actor(uuid,uuid)',
    'public.worker_edit_history_snapshot(uuid)',
    'public.direct_entry_worker_edit_history_capture_before()',
    'public.direct_entry_write_revision(uuid,uuid,uuid,jsonb,jsonb,integer)',
    'public.worker_edit_history_search(uuid,uuid,text,text,date,date,text,text,text,integer,text)',
    'public.worker_edit_history_get_revision(uuid,uuid,uuid,uuid)',
    'public.direct_entry_list_missing_document_workers(uuid,uuid,text,text,text,text,integer,integer)',
    'public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)'
  ]
  loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(v_sig);

    if v_table_owner_oid is not null
       and v_proc_owner_oid is distinct from v_table_owner_oid
       and pg_catalog.pg_has_role(current_user, v_table_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_table_owner);
    end if;
  end loop;

  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid in (
       'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::pg_catalog.regprocedure,
       'public.worker_edit_history_is_allowlisted_admin(uuid,uuid)'::pg_catalog.regprocedure,
       'public.worker_edit_history_assert_actor(uuid,uuid)'::pg_catalog.regprocedure,
       'public.worker_edit_history_snapshot(uuid)'::pg_catalog.regprocedure,
       'public.direct_entry_worker_edit_history_capture_before()'::pg_catalog.regprocedure,
       'public.direct_entry_write_revision(uuid,uuid,uuid,jsonb,jsonb,integer)'::pg_catalog.regprocedure,
       'public.worker_edit_history_search(uuid,uuid,text,text,date,date,text,text,text,integer,text)'::pg_catalog.regprocedure,
       'public.worker_edit_history_get_revision(uuid,uuid,uuid,uuid)'::pg_catalog.regprocedure,
       'public.direct_entry_list_missing_document_workers(uuid,uuid,text,text,text,text,integer,integer)'::pg_catalog.regprocedure,
       'public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)'::pg_catalog.regprocedure
     )
  loop
    execute pg_catalog.format(
      'grant select, insert on table public.direct_entry_worker_revision_snapshots to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.worker_edit_history_is_allowlisted_admin(uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.worker_edit_history_assert_actor(uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.worker_edit_history_snapshot(uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_worker_edit_history_capture_before() to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_write_revision(uuid,uuid,uuid,jsonb,jsonb,integer) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_actor_is_assigned_project_manager(uuid,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_capability(uuid,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_scope(uuid,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_actor_mapping(uuid,uuid) to %I',
      v_owner
    );
  end loop;
end;
$align_owners$;

revoke all on table public.direct_entry_worker_revision_snapshots
  from public, anon, authenticated, service_role;

revoke all on function public.worker_edit_history_is_allowlisted_admin(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.worker_edit_history_assert_actor(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.worker_edit_history_snapshot(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_worker_edit_history_capture_before()
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_write_revision(uuid, uuid, uuid, jsonb, jsonb, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_resolve_direct_edit_authority(
  uuid, uuid, uuid, uuid, text, boolean, uuid
) from public, anon, authenticated, service_role;

revoke all on function public.worker_edit_history_search(
  uuid, uuid, text, text, date, date, text, text, text, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.worker_edit_history_search(
  uuid, uuid, text, text, date, date, text, text, text, integer, text
) to service_role;

revoke all on function public.worker_edit_history_get_revision(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.worker_edit_history_get_revision(
  uuid, uuid, uuid, uuid
) to service_role;

revoke all on function public.direct_entry_list_missing_document_workers(
  uuid, uuid, text, text, text, text, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_missing_document_workers(
  uuid, uuid, text, text, text, text, integer, integer
) to service_role;

do $self_check$
declare
  v_search regprocedure :=
    'public.worker_edit_history_search(uuid,uuid,text,text,date,date,text,text,text,integer,text)'::pg_catalog.regprocedure;
  v_detail regprocedure :=
    'public.worker_edit_history_get_revision(uuid,uuid,uuid,uuid)'::pg_catalog.regprocedure;
  v_missing regprocedure :=
    'public.direct_entry_list_missing_document_workers(uuid,uuid,text,text,text,text,integer,integer)'::pg_catalog.regprocedure;
  v_helper regprocedure;
begin
  if not exists (
    select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'direct_entry_worker_revision_snapshots'
       and c.relrowsecurity = true
       and c.relforcerowsecurity = true
  ) then
    raise exception 'worker revision snapshots table must enforce forced RLS' using errcode = '55000';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_policies p
     where p.schemaname = 'public'
       and p.tablename = 'direct_entry_worker_revision_snapshots'
  ) then
    raise exception 'worker revision snapshots table must have zero client policies' using errcode = '55000';
  end if;

  if pg_catalog.has_table_privilege('anon', 'public.direct_entry_worker_revision_snapshots', 'SELECT,INSERT,UPDATE,DELETE')
     or pg_catalog.has_table_privilege('authenticated', 'public.direct_entry_worker_revision_snapshots', 'SELECT,INSERT,UPDATE,DELETE')
     or pg_catalog.has_table_privilege('service_role', 'public.direct_entry_worker_revision_snapshots', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'worker revision snapshots table must remain inaccessible to runtime roles' using errcode = '55000';
  end if;

  if (
    select count(*)::int
      from pg_catalog.pg_trigger t
     where not t.tgisinternal
       and t.tgname in (
         'direct_entry_worker_edit_history_capture_before_entries',
         'direct_entry_worker_edit_history_capture_before_payments',
         'direct_entry_worker_edit_history_capture_before_status_events',
         'direct_entry_worker_edit_history_capture_before_document_versions',
         'direct_entry_worker_edit_history_capture_before_document_events'
       )
  ) <> 5 then
    raise exception 'worker edit history before-capture triggers must be installed on all five tables' using errcode = '55000';
  end if;

  if pg_catalog.has_function_privilege('public', v_search, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_search, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_search, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_search, 'EXECUTE')
     or pg_catalog.has_function_privilege('public', v_detail, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_detail, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_detail, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_detail, 'EXECUTE')
     or pg_catalog.has_function_privilege('public', v_missing, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_missing, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_missing, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_missing, 'EXECUTE') then
    raise exception 'worker edit history and missing documents RPCs must be executable only by service_role' using errcode = '55000';
  end if;

  for v_helper in
    select unnest(array[
      'public.worker_edit_history_is_allowlisted_admin(uuid,uuid)'::pg_catalog.regprocedure,
      'public.worker_edit_history_assert_actor(uuid,uuid)'::pg_catalog.regprocedure,
      'public.worker_edit_history_snapshot(uuid)'::pg_catalog.regprocedure,
      'public.direct_entry_worker_edit_history_capture_before()'::pg_catalog.regprocedure
    ])
  loop
    if pg_catalog.has_function_privilege('public', v_helper, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_helper, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_helper, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_helper, 'EXECUTE') then
      raise exception 'worker edit history internal helper % must not be directly executable', v_helper using errcode = '55000';
    end if;
  end loop;
end;
$self_check$;

commit;
