-- PRE-W2-S1: private worker portrait on the existing direct-entry document pipeline.
begin;

alter table public.direct_entry_candidates
  add column worker_portrait_origin text
    check (worker_portrait_origin in ('ENROLLMENT', 'LEGACY_ADDED')),
  add column worker_portrait_added_at timestamptz,
  add constraint direct_entry_candidates_portrait_origin_time_check
    check (
      (worker_portrait_origin is null and worker_portrait_added_at is null)
      or (worker_portrait_origin = 'ENROLLMENT' and worker_portrait_added_at is null)
      or (worker_portrait_origin = 'LEGACY_ADDED' and worker_portrait_added_at is not null)
    );

do $constraints$
declare
  v_constraint record;
begin
  for v_constraint in
    select conname
      from pg_constraint
     where conrelid = 'public.direct_entry_document_versions'::regclass
       and contype = 'c'
       and (
         pg_get_constraintdef(oid) like '%document_type%'
         or pg_get_constraintdef(oid) like '%storage_key%'
       )
  loop
    execute format(
      'alter table public.direct_entry_document_versions drop constraint %I',
      v_constraint.conname
    );
  end loop;
end;
$constraints$;

alter table public.direct_entry_document_versions
  add constraint direct_entry_document_versions_document_type_check
    check (document_type in (
      'CCCD_FRONT', 'CCCD_BACK', 'EMPLOYMENT_CONTRACT', 'WORKER_PORTRAIT'
    )),
  add constraint direct_entry_document_versions_storage_key_check
    check (storage_key ~
      '^p1\.6/[0-9a-f-]{36}/(CCCD_FRONT|CCCD_BACK|EMPLOYMENT_CONTRACT|WORKER_PORTRAIT)/[0-9]+/[0-9a-f-]{36}$');

create or replace view public.direct_entry_current_documents
with (security_invoker = true) as
select document_id, candidate_id, document_type, version, idempotency_key,
       checksum_sha256, size_bytes, mime_type, upload_status, scan_status,
       attempts, created_by_user_id, created_at, supersedes_document_id,
       updated_at, validation_status
  from (
    select eligible_documents.*,
           row_number() over (
             partition by candidate_id, document_type
             order by version desc
           ) as current_rank
      from (
        select d.document_id, d.candidate_id, d.document_type, d.version,
               d.idempotency_key,
               coalesce(o.checksum_sha256, d.checksum_sha256) as checksum_sha256,
               coalesce(o.size_bytes, d.size_bytes) as size_bytes, d.mime_type,
               latest_event.upload_status, latest_event.scan_status,
               latest_event.attempts, d.created_by_user_id, d.created_at,
               d.supersedes_document_id, latest_event.created_at as updated_at,
               latest_event.validation_status
          from public.direct_entry_document_versions d
          left join public.direct_entry_document_objects o on o.document_id = d.document_id
          join lateral (
            select e.upload_status, e.scan_status, e.attempts, e.created_at,
                   e.validation_status
              from public.direct_entry_document_events e
             where e.document_id = d.document_id
             order by e.version desc
             limit 1
          ) latest_event on true
         where latest_event.upload_status = 'READY'
           and latest_event.validation_status = 'VALIDATED'
           and latest_event.scan_status in ('CLEAN', 'NOT_REQUIRED')
      ) eligible_documents
  ) current_documents
 where current_rank = 1;

create function public.direct_entry_w2s1_replace_function_source(
  p_signature regprocedure,
  p_expected text,
  p_replacement text,
  p_expected_count integer
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $w2s1$
declare
  v_definition text;
  v_expected text;
  v_replacement text;
  v_count integer;
begin
  select pg_get_functiondef(p_signature) into v_definition;
  if v_definition is null or p_expected is null or p_expected = '' then
    raise exception 'W2S1 function source missing' using errcode = '55000';
  end if;
  v_expected := replace(replace(p_expected, E'\r\n', E'\n'), E'\r', E'\n');
  v_replacement := replace(replace(p_replacement, E'\r\n', E'\n'), E'\r', E'\n');
  v_count := (length(v_definition) - length(replace(v_definition, v_expected, '')))
    / length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'W2S1 source drift for %: expected %, found %',
      p_signature, p_expected_count, v_count using errcode = '55000';
  end if;
  execute replace(v_definition, v_expected, v_replacement);
end;
$w2s1$;
revoke all on function public.direct_entry_w2s1_replace_function_source(
  regprocedure, text, text, integer
) from public, anon, authenticated, service_role;

select public.direct_entry_w2s1_replace_function_source(
  'public.direct_entry_entry_snapshot(uuid)'::regprocedure,
  $old$    'candidate_id', e.candidate_id,$old$,
  $new$    'candidate_id', e.candidate_id,
    'worker_portrait', (
      select jsonb_build_object(
        'origin', c.worker_portrait_origin,
        'added_at', c.worker_portrait_added_at,
        'current', case when d.document_id is null then null else jsonb_build_object(
          'document_id', d.document_id, 'version', d.version,
          'checksum_sha256', d.checksum_sha256, 'mime_type', d.mime_type,
          'size_bytes', d.size_bytes
        ) end
      )
        from public.direct_entry_candidates c
        left join lateral (
          select cd.document_id, cd.version, cd.checksum_sha256, cd.mime_type, cd.size_bytes
            from public.direct_entry_current_documents cd
           where cd.candidate_id = c.candidate_id
             and cd.document_type = 'WORKER_PORTRAIT'
        ) d on true
       where c.candidate_id = e.candidate_id
    ),$new$,
  1
);

select public.direct_entry_w2s1_replace_function_source(
  'public.direct_entry_read_projection(uuid,uuid,uuid)'::regprocedure,
  $old$  v_scope := public.direct_entry_resolve_submission_read_scope(
    p_auth_subject, p_app_user_id, v_entry.entry_id
  );$old$,
  $new$  v_scope := public.direct_entry_resolve_submission_read_scope(
    p_auth_subject, p_app_user_id, v_entry.entry_id
  );
  if v_scope is null then
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'entry_privileged_edit',
      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
    );
  end if;$new$,
  1
);

select public.direct_entry_w2s1_replace_function_source(
  'public.direct_entry_read_projection(uuid,uuid,uuid)'::regprocedure,
  $old$    'documents', case when v_documents then ($old$,
  $new$    'worker_portrait', case when v_documents then (
      select jsonb_build_object(
        'origin', c.worker_portrait_origin,
        'added_at', c.worker_portrait_added_at,
        'status', coalesce(latest.upload_status, 'MISSING'),
        'current', case when current_document.document_id is null then null
          else jsonb_build_object(
            'document_id', current_document.document_id,
            'version', current_document.version,
            'checksum_sha256', current_document.checksum_sha256,
            'mime_type', current_document.mime_type,
            'size_bytes', current_document.size_bytes
          )
        end
      )
        from public.direct_entry_candidates c
        left join lateral (
          select e.upload_status
            from public.direct_entry_document_versions d
            join lateral (
              select ev.upload_status
                from public.direct_entry_document_events ev
               where ev.document_id = d.document_id
               order by ev.version desc
               limit 1
            ) e on true
           where d.candidate_id = c.candidate_id
             and d.document_type = 'WORKER_PORTRAIT'
           order by d.version desc
           limit 1
        ) latest on true
        left join lateral (
          select cd.document_id, cd.version, cd.checksum_sha256, cd.mime_type, cd.size_bytes
            from public.direct_entry_current_documents cd
           where cd.candidate_id = c.candidate_id
             and cd.document_type = 'WORKER_PORTRAIT'
        ) current_document on true
       where c.candidate_id = v_entry.candidate_id
    ) else null end,
    'documents', case when v_documents then ($new$,
  1
);

select public.direct_entry_w2s1_replace_function_source(
  'public.direct_entry_read_projection(uuid,uuid,uuid)'::regprocedure,
  $old$       where d.candidate_id = v_entry.candidate_id$old$,
  $new$       where d.candidate_id = v_entry.candidate_id
         and d.document_type <> 'WORKER_PORTRAIT'$new$,
  1
);

select public.direct_entry_w2s1_replace_function_source(
  'public.direct_entry_reserve_document_direct_upload(uuid,uuid,uuid,integer,text,text,bigint,text,text)'::regprocedure,
  $old$if p_document_type not in ('CCCD_FRONT', 'CCCD_BACK', 'EMPLOYMENT_CONTRACT')
     or p_idempotency_key is null$old$,
  $new$if p_document_type not in (
       'CCCD_FRONT', 'CCCD_BACK', 'EMPLOYMENT_CONTRACT', 'WORKER_PORTRAIT'
     )
     or (p_document_type = 'WORKER_PORTRAIT' and p_mime_type = 'application/pdf')
     or p_idempotency_key is null$new$,
  1
);

select public.direct_entry_w2s1_replace_function_source(
  'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)'::regprocedure,
  $old$if p_purpose not in ('finalize', 'download') then$old$,
  $new$if p_purpose not in ('finalize', 'download', 'preview') then$new$,
  1
);

select public.direct_entry_w2s1_replace_function_source(
  'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)'::regprocedure,
  $old$  v_entry public.direct_entries%rowtype;
  v_document public.direct_entry_document_versions%rowtype;$old$,
  $new$  v_entry public.direct_entries%rowtype;
  v_document public.direct_entry_document_versions%rowtype;
  v_scope text;$new$,
  1
);

select public.direct_entry_w2s1_replace_function_source(
  'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)'::regprocedure,
  $old$    perform public.direct_entry_assert_draft_access(
      p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
      v_entry.team_id, v_entry.first_work_date
    );$old$,
  $new$    v_scope := public.direct_entry_resolve_submission_read_scope(
      p_auth_subject, p_app_user_id, v_entry.entry_id
    );
    if v_scope is null then
      v_scope := public.direct_entry_assert_entry_access(
        p_auth_subject, p_app_user_id, 'entry_privileged_edit',
        v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
      );
    end if;$new$,
  1
);

select public.direct_entry_w2s1_replace_function_source(
  'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)'::regprocedure,
  $old$  select * into v_latest from public.direct_entry_document_events e
   where e.document_id = p_document_id order by e.version desc limit 1;
  if p_purpose = 'download' and not ($old$,
  $new$  select * into v_latest from public.direct_entry_document_events e
   where e.document_id = p_document_id order by e.version desc limit 1;
  if p_purpose = 'download' and v_document.document_type = 'WORKER_PORTRAIT' then
    raise exception 'portrait requires private preview' using errcode = 'P0002';
  end if;
  if p_purpose = 'preview' and (
    v_document.document_type <> 'WORKER_PORTRAIT'
    or not exists (
      select 1 from public.direct_entry_current_documents cd
       where cd.document_id = p_document_id
         and cd.candidate_id = v_entry.candidate_id
         and cd.document_type = 'WORKER_PORTRAIT'
    )
  ) then
    raise exception 'portrait is not current' using errcode = 'P0002';
  end if;
  if p_purpose in ('download', 'preview') and not ($new$,
  1
);

select public.direct_entry_w2s1_replace_function_source(
  'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)'::regprocedure,
  $old$    'size_bytes', v_document.size_bytes, 'mime_type', v_document.mime_type,
    'upload_status', v_latest.upload_status,$old$,
  $new$    'size_bytes', coalesce((
      select o.size_bytes from public.direct_entry_document_objects o
       where o.document_id = v_document.document_id
    ), v_document.size_bytes),
    'mime_type', v_document.mime_type,
    'checksum_sha256', (
      select o.checksum_sha256 from public.direct_entry_document_objects o
       where o.document_id = v_document.document_id
    ),
    'upload_status', v_latest.upload_status,$new$,
  1
);

select public.direct_entry_w2s1_replace_function_source(
  'public.direct_entry_finalize_document_direct_upload(uuid,uuid,uuid,uuid,integer,text,text,text,bigint,text)'::regprocedure,
  $old$  v_upload_status text;
  v_validation_status text;
  v_result jsonb;$old$,
  $new$  v_upload_status text;
  v_validation_status text;
  v_submission_state text;
  v_result jsonb;$new$,
  1
);

select public.direct_entry_w2s1_replace_function_source(
  'public.direct_entry_finalize_document_direct_upload(uuid,uuid,uuid,uuid,integer,text,text,text,bigint,text)'::regprocedure,
  $old$  v_scope := public.direct_entry_assert_document_upload_access(
    p_auth_subject, p_app_user_id, p_entry_id
  );$old$,
  $new$  v_scope := public.direct_entry_assert_document_upload_access(
    p_auth_subject, p_app_user_id, p_entry_id
  );
  select s.state into v_submission_state
    from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id;$new$,
  1
);

select public.direct_entry_w2s1_replace_function_source(
  'public.direct_entry_finalize_document_direct_upload(uuid,uuid,uuid,uuid,integer,text,text,text,bigint,text)'::regprocedure,
  $old$  if p_outcome = 'validated' and (
    v_document.size_bytes <> p_size_bytes or v_document.mime_type <> p_mime_type
  ) then$old$,
  $new$  if p_outcome = 'validated' and (
    (v_document.document_type <> 'WORKER_PORTRAIT' and v_document.size_bytes <> p_size_bytes)
    or v_document.mime_type <> p_mime_type
  ) then$new$,
  1
);

select public.direct_entry_w2s1_replace_function_source(
  'public.direct_entry_finalize_document_direct_upload(uuid,uuid,uuid,uuid,integer,text,text,text,bigint,text)'::regprocedure,
  $old$  update public.direct_entries set version = version + 1 where entry_id = p_entry_id;$old$,
  $new$  if p_outcome = 'validated' and v_document.document_type = 'WORKER_PORTRAIT' then
    update public.direct_entry_candidates
       set worker_portrait_origin = coalesce(
             worker_portrait_origin,
             case when v_submission_state = 'DRAFT' then 'ENROLLMENT' else 'LEGACY_ADDED' end
           ),
           worker_portrait_added_at = case
             when worker_portrait_origin is null and v_submission_state <> 'DRAFT'
               then clock_timestamp()
             else worker_portrait_added_at
           end
     where candidate_id = v_entry.candidate_id;
  end if;
  update public.direct_entries set version = version + 1 where entry_id = p_entry_id;$new$,
  1
);

drop function public.direct_entry_w2s1_replace_function_source(
  regprocedure, text, text, integer
);

-- The read RPC keeps independent draft/privileged scope and PII/payment/document gates.
do $checks$
declare
  v_read text;
  v_context text;
  v_finalize text;
begin
  select pg_get_functiondef(
    'public.direct_entry_read_projection(uuid,uuid,uuid)'::regprocedure
  ) into v_read;
  select pg_get_functiondef(
    'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)'::regprocedure
  ) into v_context;
  select pg_get_functiondef(
    'public.direct_entry_finalize_document_direct_upload(uuid,uuid,uuid,uuid,integer,text,text,text,bigint,text)'::regprocedure
  ) into v_finalize;
  if v_read not like '%entry_privileged_edit%'
     or v_read not like '%worker_portrait%'
     or v_read not like '%labor_type_display%'
     or v_read not like '%pii_view%'
     or v_read not like '%payment_view%'
     or v_read not like '%document_view%' then
    raise exception 'W2S1 read projection contract drift' using errcode = '55000';
  end if;
  if v_context not like '%preview%'
     or v_context not like '%document_view%'
     or v_context not like '%entry_privileged_edit%'
     or v_context not like '%checksum_sha256%' then
    raise exception 'W2S1 private portrait context contract drift' using errcode = '55000';
  end if;
  if v_finalize not like '%worker_portrait_origin%'
     or v_finalize not like '%v_document.document_type <> ''WORKER_PORTRAIT''%' then
    raise exception 'W2S1 sanitized finalize contract drift' using errcode = '55000';
  end if;
end;
$checks$;

commit;
