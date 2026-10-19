begin;

alter table public.direct_entry_submissions
  drop constraint direct_entry_submissions_state_check,
  add constraint direct_entry_submissions_state_check
    check (state in ('DRAFT', 'REVIEW', 'SUBMITTED', 'DELETED'));

alter table public.direct_entry_worker_portrait_stages
  add column submission_id uuid references public.direct_entry_submissions(submission_id) on delete restrict;

create function public.direct_entry_worker_document_stage_submission_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $stage$
declare
  v_submission_id uuid;
begin
  if new.status = 'ATTACHED' then
    select e.submission_id into v_submission_id
      from public.direct_entries e
     where e.entry_id = new.entry_id;
    if not found or (new.submission_id is not null and new.submission_id <> v_submission_id) then
      raise exception 'worker document stage submission mismatch' using errcode = '40001';
    end if;
    new.submission_id := v_submission_id;
  elsif new.submission_id is not null and not exists (
    select 1
      from public.direct_entry_rpc_idempotency i
     where i.app_user_id = new.created_by_user_id
       and i.action = 'full_profile_batch_create'
       and i.idempotency_key = new.claim_idempotency_key
       and i.result->>'submission_id' = new.submission_id::text
  ) then
    raise exception 'worker document stage submission mismatch' using errcode = '40001';
  end if;
  if old.submission_id is not null and new.submission_id is distinct from old.submission_id then
    raise exception 'worker document stage submission immutable' using errcode = '40001';
  end if;
  return new;
end;
$stage$;

create trigger direct_entry_worker_document_stage_submission_guard
  before update on public.direct_entry_worker_portrait_stages
  for each row execute function public.direct_entry_worker_document_stage_submission_guard();

update public.direct_entry_worker_portrait_stages s
   set submission_id = e.submission_id
  from public.direct_entries e
 where s.status = 'ATTACHED'
   and e.entry_id = s.entry_id;

update public.direct_entry_worker_portrait_stages s
   set submission_id = (i.result->>'submission_id')::uuid
  from public.direct_entry_rpc_idempotency i
 where s.status = 'CLAIMED'
   and s.created_by_user_id = i.app_user_id
   and s.claim_idempotency_key = i.idempotency_key
   and i.action = 'full_profile_batch_create'
   and i.result->>'submission_id' ~*
     '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

create table public.direct_entry_submission_object_cleanup (
  cleanup_id uuid primary key default gen_random_uuid(),
  submission_id uuid not null
    references public.direct_entry_submissions(submission_id) on delete restrict,
  object_kind text not null
    check (object_kind in ('PORTRAIT_STAGE', 'DOCUMENT_STAGED', 'DOCUMENT_FINAL')),
  stage_id uuid references public.direct_entry_worker_portrait_stages(stage_id) on delete restrict,
  document_id uuid references public.direct_entry_document_versions(document_id) on delete restrict,
  storage_key text,
  cleanup_pending_at timestamptz not null default clock_timestamp(),
  cleanup_lease_until timestamptz,
  cleanup_claim_token uuid,
  cleanup_attempts integer not null default 0 check (cleanup_attempts >= 0),
  cleanup_completed_at timestamptz,
  check (
    (object_kind = 'PORTRAIT_STAGE' and stage_id is not null and document_id is null
      and storage_key is null)
    or
    (object_kind in ('DOCUMENT_STAGED', 'DOCUMENT_FINAL') and stage_id is null
      and document_id is not null and storage_key is not null
      and storage_key ~ '^p1\.6/[0-9a-f-]{36}/[A-Z_]+/[0-9]+/[0-9a-f-]{36}$')
  ),
  check (
    (cleanup_completed_at is null and cleanup_attempts >= 0
      and ((cleanup_lease_until is null and cleanup_claim_token is null)
        or (cleanup_lease_until is not null and cleanup_claim_token is not null)))
    or
    (cleanup_completed_at is not null and cleanup_lease_until is null
      and cleanup_claim_token is null)
  )
);

create unique index direct_entry_submission_object_cleanup_stage_uq
  on public.direct_entry_submission_object_cleanup(object_kind, stage_id)
  where stage_id is not null;
create unique index direct_entry_submission_object_cleanup_document_uq
  on public.direct_entry_submission_object_cleanup(object_kind, document_id)
  where document_id is not null;
create index direct_entry_submission_object_cleanup_pending_idx
  on public.direct_entry_submission_object_cleanup(cleanup_lease_until, cleanup_pending_at)
  where cleanup_completed_at is null;

alter table public.direct_entry_submission_object_cleanup enable row level security;
alter table public.direct_entry_submission_object_cleanup force row level security;
revoke all on table public.direct_entry_submission_object_cleanup
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_create_full_profile_batch_with_portrait_stages(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_contract_version text,
  p_rows jsonb,
  p_idempotency_key text,
  p_stage_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $batch$
declare
  v_stage_id uuid;
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
  v_result jsonb;
  v_submission_id uuid;
  v_linked integer;
begin
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'document_upload'
  );
  if p_idempotency_key is null or
     p_idempotency_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_stage_ids is null or cardinality(p_stage_ids) not between 1 and 400
     or exists (select 1 from unnest(p_stage_ids) id where id is null)
     or (select count(distinct id) from unnest(p_stage_ids) id) <> cardinality(p_stage_ids) then
    raise exception 'worker document stage batch invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_app_user_id::text || ':' || p_idempotency_key, 0)
  );
  for v_stage_id in select id from unnest(p_stage_ids) id order by id loop
    select * into v_stage
      from public.direct_entry_worker_portrait_stages
     where stage_id = v_stage_id and created_by_user_id = p_app_user_id
     for update;
    if not found then
      raise exception 'worker document stage not found' using errcode = '42501';
    end if;
    if v_stage.status not in ('CLAIMED', 'ATTACHED')
       or v_stage.claim_idempotency_key <> p_idempotency_key then
      raise exception 'worker document stage claim conflict' using errcode = '40001';
    end if;
  end loop;

  v_result := public.direct_entry_create_full_profile_batch_v2(
    p_auth_subject, p_app_user_id, p_contract_version, p_rows, p_idempotency_key
  );
  v_submission_id := (v_result->>'submission_id')::uuid;

  update public.direct_entry_worker_portrait_stages s
     set submission_id = v_submission_id
   where s.stage_id = any(p_stage_ids)
     and s.created_by_user_id = p_app_user_id
     and s.claim_idempotency_key = p_idempotency_key
     and s.submission_id is null
     and (
       s.status = 'CLAIMED'
       or (s.status = 'ATTACHED' and exists (
         select 1 from public.direct_entries e
          where e.entry_id = s.entry_id and e.submission_id = v_submission_id
       ))
     );
  get diagnostics v_linked = row_count;
  if v_linked <> cardinality(p_stage_ids) then
    raise exception 'worker document stage submission mismatch' using errcode = '40001';
  end if;

  return v_result;
end;
$batch$;

create or replace function public.direct_entry_submission_transition_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.created_by_user_id <> old.created_by_user_id
     or new.version <> old.version + 1
     or old.state = 'SUBMITTED'
     or not (
       (old.state = 'DRAFT' and new.state = 'DRAFT') or
       (old.state = 'DRAFT' and new.state in ('SUBMITTED', 'DELETED')) or
       (old.state = 'REVIEW' and new.state in ('DRAFT', 'SUBMITTED'))
     ) then
    raise exception 'invalid submission mutation or stale version' using errcode = '40001';
  end if;
  new.submitted_at := case when new.state = 'SUBMITTED' then now() else null end;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.direct_entry_require_nonempty_submission()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.state <> 'DELETED' and not exists (
    select 1
      from public.direct_entry_submissions s
      join public.direct_entries e on e.submission_id = s.submission_id
     where s.submission_id = new.submission_id
       and e.deleted_at is null
  ) then
    raise exception 'submission must contain at least one entry' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.direct_entry_submissions s
      join public.direct_entries e on e.submission_id = s.submission_id
     where s.submission_id = new.submission_id
       and e.created_by_user_id <> s.created_by_user_id
  ) then
    raise exception 'submission owner must match every entry creator' using errcode = '23514';
  end if;
  return null;
end;
$$;

alter function public.direct_entry_require_nonempty_submission() security definer;
alter function public.direct_entry_require_nonempty_submission()
  set search_path = pg_catalog, public;
alter function public.direct_entry_require_nonempty_submission() owner to postgres;
revoke all on function public.direct_entry_require_nonempty_submission()
  from public, anon, authenticated, service_role;

create function public.direct_entry_delete_draft_submission(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_submission_id uuid,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $delete$
declare
  v_submission public.direct_entry_submissions%rowtype;
  v_entry public.direct_entries%rowtype;
  v_scope text;
  v_own_scope_count integer;
  v_prior jsonb;
  v_result jsonb;
  v_request_hash text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_submission_revision_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_deleted_at timestamptz := clock_timestamp();
  v_deleted_entries integer := 0;
  v_cleanup_objects integer := 0;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'submission_create'
  );

  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;
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

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'submission_id', p_submission_id,
    'expected_version', p_expected_version
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'draft_submission_delete', p_idempotency_key, v_request_hash
  );
  if v_prior is not null then return v_prior; end if;

  perform 1
    from public.direct_entries e
   where e.submission_id = p_submission_id and e.deleted_at is null
   order by e.entry_id
   for update;

  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id
   for update;
  if not found or v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission.state <> 'DRAFT' then
    raise exception 'submission is not a draft' using errcode = '55000';
  end if;
  if p_expected_version is null or p_expected_version <> v_submission.version then
    raise exception 'submission version conflict' using errcode = '40001';
  end if;
  if exists (
    select 1 from public.direct_entry_worker_portrait_stages s
     where s.submission_id = p_submission_id and s.status = 'CLAIMED'
  ) then
    raise exception 'submission document processing' using errcode = '55P03';
  end if;
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

  v_before := jsonb_build_object(
    'state', v_submission.state,
    'version', v_submission.version,
    'entry_count', (
      select count(*)::int from public.direct_entries e
       where e.submission_id = p_submission_id and e.deleted_at is null
    ),
    'submitted_at', v_submission.submitted_at
  );
  v_reason_id := public.direct_entry_reason(p_app_user_id, 'Draft submission deletion');

  for v_entry in
    select e.* from public.direct_entries e
     where e.submission_id = p_submission_id and e.deleted_at is null
     order by e.entry_id
  loop
    v_scope := public.direct_entry_assert_draft_access(
      p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
      v_entry.team_id, v_entry.first_work_date
    );
    if v_scope <> 'own' then
      raise exception 'submission own scope denied' using errcode = '42501';
    end if;
    v_after := public.direct_entry_entry_snapshot(v_entry.entry_id);
    update public.direct_entries
       set deleted_at = v_deleted_at, version = version + 1
     where entry_id = v_entry.entry_id;
    v_revision_id := public.direct_entry_write_revision(
      v_entry.entry_id, p_app_user_id, v_reason_id, v_after,
      public.direct_entry_entry_snapshot(v_entry.entry_id), v_entry.version + 1
    );
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, outcome, reason_id, revision_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'draft_submission_delete', 'submission_create',
      v_entry.entry_id::text, 'own', 'APPLIED', v_reason_id, v_revision_id,
      array['deleted_at']
    );
    v_deleted_entries := v_deleted_entries + 1;
  end loop;

  insert into public.direct_entry_submission_object_cleanup (
    submission_id, object_kind, stage_id
  )
  select p_submission_id, 'PORTRAIT_STAGE', s.stage_id
    from public.direct_entry_worker_portrait_stages s
   where s.submission_id = p_submission_id and s.status = 'ATTACHED'
  on conflict do nothing;

  insert into public.direct_entry_submission_object_cleanup (
    submission_id, object_kind, document_id, storage_key
  )
  select p_submission_id, kinds.object_kind, d.document_id, d.storage_key
    from public.direct_entry_document_versions d
    join public.direct_entries e on e.candidate_id = d.candidate_id
    cross join (values ('DOCUMENT_STAGED'), ('DOCUMENT_FINAL')) as kinds(object_kind)
   where e.submission_id = p_submission_id
     and not exists (
       select 1 from public.direct_entries other
        where other.candidate_id = d.candidate_id
          and other.submission_id <> p_submission_id
     )
  on conflict do nothing;

  update public.direct_entry_submissions
     set state = 'DELETED', version = version + 1
   where submission_id = p_submission_id;
  v_submission_revision_id := public.direct_entry_write_submission_revision(
    p_submission_id, p_app_user_id, v_reason_id, v_before,
    jsonb_build_object(
      'state', 'DELETED',
      'version', v_submission.version + 1,
      'entry_count', 0,
      'deleted_entry_count', v_deleted_entries,
      'deleted_at', v_deleted_at
    ),
    v_submission.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'draft_submission_delete', 'submission_create',
    p_submission_id::text, 'own', 'APPLIED', v_reason_id,
    v_submission_revision_id, array['state', 'entries_deleted']
  );

  select count(*)::int into v_cleanup_objects
    from public.direct_entry_submission_object_cleanup c
   where c.submission_id = p_submission_id and c.cleanup_completed_at is null;
  v_result := jsonb_build_object(
    'submission_id', p_submission_id,
    'deleted', true,
    'version', v_submission.version + 1,
    'entries_deleted', v_deleted_entries,
    'cleanup_objects_queued', v_cleanup_objects
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'draft_submission_delete', p_idempotency_key, v_result
  );
  return v_result;
end;
$delete$;

create function public.direct_entry_claim_submission_object_cleanup(
  p_claim_token uuid,
  p_limit integer default 50
)
returns table (
  cleanup_id uuid,
  object_kind text,
  stage_id uuid,
  storage_key text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $cleanup$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_claim_token is null or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'submission cleanup claim invalid' using errcode = '22023';
  end if;
  return query
  with eligible as (
    select c.cleanup_id
      from public.direct_entry_submission_object_cleanup c
     where c.cleanup_completed_at is null
       and (c.cleanup_lease_until is null or c.cleanup_lease_until <= v_now)
     order by c.cleanup_pending_at, c.cleanup_id
     for update skip locked
     limit p_limit
  ), claimed as (
    update public.direct_entry_submission_object_cleanup c
       set cleanup_lease_until = v_now + interval '5 minutes',
           cleanup_claim_token = p_claim_token,
           cleanup_attempts = c.cleanup_attempts + 1
      from eligible e
     where c.cleanup_id = e.cleanup_id
     returning c.cleanup_id, c.object_kind, c.stage_id, c.storage_key
  )
  select claimed.cleanup_id, claimed.object_kind, claimed.stage_id, claimed.storage_key
    from claimed
   order by claimed.cleanup_id;
end;
$cleanup$;

create function public.direct_entry_complete_submission_object_cleanup(
  p_cleanup_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $cleanup$
begin
  if p_cleanup_id is null or p_claim_token is null then
    raise exception 'submission cleanup completion invalid' using errcode = '22023';
  end if;
  update public.direct_entry_submission_object_cleanup
     set cleanup_completed_at = clock_timestamp(),
         cleanup_lease_until = null,
         cleanup_claim_token = null
   where cleanup_id = p_cleanup_id
     and cleanup_completed_at is null
     and cleanup_claim_token = p_claim_token;
  return found;
end;
$cleanup$;

do $hide_deleted_submissions$
declare
  v_definition text;
  v_updated text;
  v_old text;
  v_new text;
begin
  v_definition := pg_get_functiondef(
    'public.direct_entry_list_own_submissions(uuid,uuid,integer,text,text)'::regprocedure
  );
  v_old := 'where (' || chr(10) ||
    '             (v_can_list_own and s.created_by_user_id = p_app_user_id)';
  v_new := 'where s.state <> ''DELETED'' and (' || chr(10) ||
    '             (v_can_list_own and s.created_by_user_id = p_app_user_id)';
  v_updated := replace(v_definition, v_old, v_new);
  if v_updated = v_definition or
     length(v_definition) - length(replace(v_definition, v_old, '')) <> length(v_old) then
    raise exception 'could not safely hide deleted submissions from list';
  end if;
  execute v_updated;

  v_definition := pg_get_functiondef(
    'public.direct_entry_read_own_submission(uuid,uuid,uuid)'::regprocedure
  );
  v_old := 'where s.submission_id = p_submission_id;';
  v_new := 'where s.submission_id = p_submission_id and s.state <> ''DELETED'';';
  v_updated := replace(v_definition, v_old, v_new);
  if v_updated = v_definition or
     length(v_definition) - length(replace(v_definition, v_old, '')) <> length(v_old) then
    raise exception 'could not safely hide deleted submissions from read';
  end if;
  execute v_updated;
end;
$hide_deleted_submissions$;

revoke all on function public.direct_entry_worker_document_stage_submission_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_delete_draft_submission(uuid, uuid, uuid, integer, text)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_claim_submission_object_cleanup(uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_complete_submission_object_cleanup(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_create_full_profile_batch_with_portrait_stages(
  uuid, uuid, text, jsonb, text, uuid[]
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_delete_draft_submission(uuid, uuid, uuid, integer, text)
  to service_role;
grant execute on function public.direct_entry_claim_submission_object_cleanup(uuid, integer)
  to service_role;
grant execute on function public.direct_entry_complete_submission_object_cleanup(uuid, uuid)
  to service_role;
grant execute on function public.direct_entry_create_full_profile_batch_with_portrait_stages(
  uuid, uuid, text, jsonb, text, uuid[]
) to service_role;

commit;
